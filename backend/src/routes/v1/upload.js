import { Router, raw } from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { config } from '../../config.js'
import { authMiddleware } from '../../middleware/auth.js'
import { sendError } from '../../lib/httpError.js'
import { ffmpegAvailable, probe as probeMedia } from '../../media/ffmpeg.js'
import { ensureSafeDirectory as ensureSafeStorageDirectory, findSymlinkInPath, isPathInside } from '../../lib/safePath.js'
import { markLegacyUploadActive, releaseLegacyUpload } from '../../services/legacyUploadRegistry.js'
import { assertVideoFile, MediaValidationError, validateVideoMetadata } from '../../services/mediaValidation.js'
import { CHUNK_SIZE, MAX_SIZE, resumableUploadService, UploadServiceError } from '../../services/resumableUploadService.js'

const LEGACY_MAX_SIZE = 4 * 1024 * 1024 * 1024

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

async function defaultMediaProbe(filePath) {
  const available = await ffmpegAvailable()
  if (!available.ok) return { available: false, codec: null }
  return { available: true, ...(await probeMedia(filePath)) }
}

function errorPayload(error) {
  if (error instanceof UploadServiceError || error instanceof MediaValidationError) {
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
      extra: error.extra || {},
    }
  }
  if (error?.type === 'entity.too.large') {
    return { status: 413, code: 'CHUNK_TOO_LARGE', message: 'Chunk exceeds the 16MB request limit', extra: {} }
  }
  if (error?.code === 'LIMIT_FILE_SIZE') {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'File exceeds the 4GB upload limit', extra: {} }
  }
  if (error?.code === 'LIMIT_UNEXPECTED_FILE') {
    return { status: 400, code: 'VALIDATION', message: 'Unexpected upload field', extra: { field: 'file' } }
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error', extra: {} }
}

export function createUploadRouter({
  service = resumableUploadService,
  mediaProbe = defaultMediaProbe,
  legacyUuid = uuidv4,
  legacyFileSystem = fs,
} = {}) {
  const router = Router()
  const legacyRoot = path.join(config.storageDir, 'tmp', 'legacy_uploads')
  const ensureUploadDirectory = async (relativeDirectory) => {
    try {
      return await ensureSafeStorageDirectory({ root: config.storageDir, relativeDirectory, fileSystem: legacyFileSystem })
    } catch (error) {
      if (error?.code === 'UNSAFE_STORAGE_PATH') {
        throw new UploadServiceError(409, 'UPLOAD_PATH_UNSAFE', 'Upload directory path is unsafe')
      }
      throw error
    }
  }
  const ensureLegacyStaging = (req, res, next) => {
    ensureUploadDirectory(path.join('tmp', 'legacy_uploads')).then(() => next()).catch(next)
  }

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, legacyRoot),
    filename: (req, file, cb) => {
      const filename = `${legacyUuid()}.upload`
      req.legacyUploadPath = path.join(legacyRoot, filename)
      markLegacyUploadActive(req.legacyUploadPath)
      cb(null, filename)
    },
  })

  const legacyUpload = multer({
    storage,
    limits: { fileSize: LEGACY_MAX_SIZE, files: 1 },
    fileFilter: (req, file, cb) => {
      try {
        req.uploadMedia = validateVideoMetadata({ filename: file.originalname, mime: file.mimetype })
        cb(null, true)
      } catch (error) {
        cb(error)
      }
    },
  })

  router.use(authMiddleware)

  router.post('/', ensureLegacyStaging, legacyUpload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) return sendError(res, 400, 'VALIDATION', 'No file uploaded', { field: 'file' })
    const stagedPath = req.file.path
    try {
      const media = req.uploadMedia || validateVideoMetadata({ filename: req.file.originalname, mime: req.file.mimetype })
      const stagedStat = await legacyFileSystem.promises.lstat(stagedPath)
      if (!stagedStat.isFile() || stagedStat.isSymbolicLink()) {
        throw new MediaValidationError('Uploaded file is not a regular file')
      }
      if (stagedStat.size <= 0 || stagedStat.size > LEGACY_MAX_SIZE) {
        throw new MediaValidationError('Uploaded file size is invalid')
      }
      await assertVideoFile(stagedPath, media.extension, { probe: mediaProbe })
      const storageKey = `uploads/${legacyUuid()}${media.extension}`
      const finalPath = path.join(config.storageDir, storageKey)
      if (!isPathInside(config.storageDir, finalPath)) {
        throw new MediaValidationError('Final upload path is unsafe')
      }
      await ensureUploadDirectory('uploads')
      if (await findSymlinkInPath(config.storageDir, finalPath, legacyFileSystem)) {
        throw new UploadServiceError(409, 'UPLOAD_PATH_UNSAFE', 'Final upload path contains a symlink')
      }
      await legacyFileSystem.promises.rename(stagedPath, finalPath)
      return res.json({
        key: storageKey,
        url: `/storage/${storageKey}`,
        filename: media.filename,
        size: req.file.size,
        mimetype: media.mime,
      })
    } catch (error) {
      await legacyFileSystem.promises.unlink(stagedPath).catch(() => {})
      throw error
    } finally {
      releaseLegacyUpload(req.legacyUploadPath)
    }
  }))

  router.post('/init', asyncHandler(async (req, res) => {
    const body = req.body || {}
    const result = await service.createSession({
      userId: req.user.id,
      filename: body.filename,
      size: body.size,
      mime: body.mime,
    })
    res.status(201).json(result)
  }))

  router.head('/:id', asyncHandler(async (req, res) => {
    const session = await service.getOwnedSession({ id: req.params.id, userId: req.user.id })
    res.set('Upload-Offset', String(Number(session.bytes_received) || 0))
    res.set('Cache-Control', 'no-store')
    res.status(200).end()
  }))

  const rawBody = raw({ type: 'application/octet-stream', limit: '16mb' })
  router.put('/:id/chunk', rawBody, asyncHandler(async (req, res) => {
    const offset = Number(req.query.offset)
    const result = await service.appendChunk({
      id: req.params.id,
      userId: req.user.id,
      offset,
      chunk: req.body,
    })
    res.set('Upload-Offset', String(result.received))
    res.status(204).end()
  }))

  router.post('/:id/complete', asyncHandler(async (req, res) => {
    const result = await service.complete({ id: req.params.id, userId: req.user.id })
    res.json(result)
  }))

  router.use((error, req, res, next) => {
    const finish = async () => {
      if (req.legacyUploadPath) {
        try {
          await legacyFileSystem.promises.unlink(req.legacyUploadPath)
        } catch (_) {
        } finally {
          releaseLegacyUpload(req.legacyUploadPath)
        }
      }
      if (res.headersSent) return next(error)
      const payload = errorPayload(error)
      if (payload.status >= 500) {
        console.error(JSON.stringify({ event: 'upload_http_failed', route: req.route?.path || req.path, code: payload.code }))
      }
      return sendError(res, payload.status, payload.code, payload.message, payload.extra)
    }
    finish().catch(next)
  })

  return router
}

export { CHUNK_SIZE, MAX_SIZE }
export default createUploadRouter()
