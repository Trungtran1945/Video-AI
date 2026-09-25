import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { config } from '../config.js'
import { query, queryOne, insert, run, runAffected } from '../db/query.js'
import { ffmpegAvailable, probe as probeMedia } from '../media/ffmpeg.js'
import { ensureSafeDirectory, findSymlinkInPath, isPathInside } from '../lib/safePath.js'
import { assertVideoFile, MediaValidationError, validateVideoMetadata } from './mediaValidation.js'

export const CHUNK_SIZE = 8 * 1024 * 1024
export const MAX_SIZE = 2 * 1024 * 1024 * 1024

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STORAGE_KEY_RE = /^uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(mp4|m4v|mov|mkv|webm))$/i

export class UploadServiceError extends Error {
  constructor(statusCode, code, message, extra = {}) {
    super(message)
    this.name = 'UploadServiceError'
    this.statusCode = statusCode
    this.code = code
    this.extra = extra
  }
}

function shortId(id) {
  return String(id || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8)
}

function isUuid(value) {
  return UUID_RE.test(String(value || ''))
}

function nowIso(now) {
  return new Date(now()).toISOString()
}

function isExpired(session, now) {
  return Boolean(session?.expires_at && Date.parse(session.expires_at) <= now())
}

function assertOwnedSession(session) {
  if (!session) throw new UploadServiceError(404, 'NOT_FOUND', 'Session not found')
  return session
}

function assertPending(session) {
  if (session.status === 'completed') {
    throw new UploadServiceError(409, 'UPLOAD_COMPLETED', 'Upload is already completed')
  }
  if (session.status === 'expired') {
    throw new UploadServiceError(410, 'UPLOAD_EXPIRED', 'Upload session has expired')
  }
  if (session.status !== 'pending') {
    throw new UploadServiceError(409, 'UPLOAD_NOT_PENDING', 'Upload session is not pending')
  }
}

function containedPath(root, target) {
  return isPathInside(root, target)
}

async function defaultHashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function defaultProbe(filePath) {
  const available = await ffmpegAvailable()
  if (!available.ok) return { available: false, codec: null }
  return { available: true, ...(await probeMedia(filePath)) }
}

async function syncDirectory(fileSystem, directory) {
  let handle
  try {
    handle = await fileSystem.promises.open(directory, 'r')
    await handle.sync()
  } catch (_) {
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function lstatOrNull(fileSystem, filePath) {
  try {
    return await fileSystem.promises.lstat(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export function createResumableUploadService({
  storageDir = config.storageDir,
  db = { query, queryOne, insert, run, runAffected },
  fileSystem = fs,
  now = () => Date.now(),
  uuid = uuidv4,
  hashFile = defaultHashFile,
  probe = defaultProbe,
  ttlMs = config.uploadSessionTtlMinutes * 60 * 1000,
  logger = console,
} = {}) {
  const locks = new Map()
  const sessionRoot = path.join(storageDir, 'tmp', 'upload_sessions')

  async function ensureUploadDirectory(relativeDirectory) {
    try {
      return await ensureSafeDirectory({ root: storageDir, relativeDirectory, fileSystem })
    } catch (error) {
      if (error?.code === 'UNSAFE_STORAGE_PATH') {
        throw new UploadServiceError(409, 'UPLOAD_PATH_UNSAFE', 'Upload directory path is unsafe')
      }
      throw error
    }
  }

  async function sessionDirPath(sessionId, { create = false } = {}) {
    if (!isUuid(sessionId)) {
      throw new UploadServiceError(404, 'NOT_FOUND', 'Session not found')
    }
    const directory = path.join(sessionRoot, sessionId)
    if (!containedPath(sessionRoot, directory)) {
      throw new UploadServiceError(409, 'UPLOAD_PATH_UNSAFE', 'Upload session path is unsafe')
    }
    if (create) {
      await ensureUploadDirectory(path.relative(storageDir, directory))
      return directory
    }
    if (await findSymlinkInPath(storageDir, directory, fileSystem)) {
      throw new UploadServiceError(409, 'UPLOAD_PATH_UNSAFE', 'Upload session path contains a symlink')
    }
    return directory
  }

  async function blobPath(sessionId) {
    return path.join(await sessionDirPath(sessionId), 'blob')
  }

  async function loadOwnedSession({ id, userId }) {
    if (!isUuid(id)) return null
    const session = await db.queryOne('SELECT * FROM upload_sessions WHERE id = ?', [id])
    if (!session || String(session.user_id) !== String(userId)) return null
    return session
  }

  async function withSessionLock(sessionId, operation) {
    const enqueuedAt = Date.now()
    const previous = locks.get(sessionId) || Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const tail = previous.catch(() => {}).then(() => gate)
    locks.set(sessionId, tail)
    await previous.catch(() => {})
    const lockWaitMs = Date.now() - enqueuedAt
    try {
      return await operation({ lockWaitMs })
    } finally {
      release()
      if (locks.get(sessionId) === tail) locks.delete(sessionId)
    }
  }

  async function ensureTempBlob(session) {
    const expected = Number(session.bytes_received) || 0
    const directory = await sessionDirPath(session.id)
    const dirStat = await lstatOrNull(fileSystem, directory)
    if (dirStat && dirStat.isSymbolicLink()) {
      throw new UploadServiceError(409, 'UPLOAD_PATH_UNSAFE', 'Upload session directory is a symlink')
    }
    if (!dirStat && expected !== 0) {
      throw new UploadServiceError(409, 'UPLOAD_DATA_MISSING', 'Upload temp data is missing')
    }
    if (!dirStat) await ensureUploadDirectory(path.relative(storageDir, directory))
    const filePath = path.join(directory, 'blob')
    const fileStat = await lstatOrNull(fileSystem, filePath)
    if (fileStat?.isSymbolicLink()) {
      throw new UploadServiceError(409, 'UPLOAD_PATH_UNSAFE', 'Upload temp file is a symlink')
    }
    if (!fileStat && expected === 0) {
      await fileSystem.promises.writeFile(filePath, Buffer.alloc(0), { flag: 'wx' })
      return { filePath, size: 0 }
    }
    if (!fileStat?.isFile()) {
      throw new UploadServiceError(409, 'UPLOAD_DATA_MISSING', 'Upload temp file is missing')
    }
    if (fileStat.size < expected) {
      throw new UploadServiceError(409, 'UPLOAD_DATA_MISSING', 'Upload temp file is shorter than committed data')
    }
    if (fileStat.size > expected) {
      await fileSystem.promises.truncate(filePath, expected)
    }
    return { filePath, size: expected }
  }

  async function removeCanonicalTemp(sessionId) {
    if (!isUuid(sessionId)) {
      logger.warn(JSON.stringify({ event: 'upload_path_rejected', uploadId: shortId(sessionId) }))
      return false
    }
    const directory = path.join(sessionRoot, sessionId)
    if (!containedPath(sessionRoot, directory)) {
      logger.warn(JSON.stringify({ event: 'upload_path_rejected', uploadId: shortId(sessionId) }))
      return false
    }
    if (await findSymlinkInPath(storageDir, directory, fileSystem)) {
      logger.warn(JSON.stringify({ event: 'upload_symlink_rejected', uploadId: shortId(sessionId) }))
      return false
    }
    const stat = await lstatOrNull(fileSystem, directory)
    if (!stat) return true
    if (stat.isSymbolicLink()) {
      logger.warn(JSON.stringify({ event: 'upload_symlink_rejected', uploadId: shortId(sessionId) }))
      return false
    }
    await fileSystem.promises.rm(directory, { recursive: true, force: true })
    return true
  }

  async function validateStoredMedia(filePath, session) {
    const metadata = validateVideoMetadata({ filename: session.filename, mime: session.mime })
    await assertVideoFile(filePath, metadata.extension, { probe: null })
    if (typeof probe === 'function') {
      let probed
      try {
        probed = await probe(filePath)
      } catch (_) {
        throw new MediaValidationError('FFprobe could not validate the video stream', { extension: metadata.extension })
      }
      if (probed?.available !== false && !probed?.codec) {
        const error = new MediaValidationError('FFprobe found no video stream', { extension: metadata.extension })
        throw error
      }
    }
    return metadata
  }

  function responseFor(session) {
    return {
      storageKey: session.storage_key,
      url: `/storage/${session.storage_key}`,
      filename: session.filename,
      size: Number(session.size),
      videoHash: session.video_hash,
    }
  }

  async function finalizeCompleting(session, { verifyTempHash = false } = {}) {
    const storageKey = String(session.storage_key || '')
    const keyMatch = STORAGE_KEY_RE.exec(storageKey)
    if (!keyMatch || !session.video_hash) {
      throw new UploadServiceError(409, 'UPLOAD_RECOVERY_FAILED', 'Completing upload metadata is invalid')
    }
    const tempPath = await blobPath(session.id)
    await ensureUploadDirectory('uploads')
    const finalPath = path.join(storageDir, storageKey)
    if (!containedPath(storageDir, finalPath)) {
      throw new UploadServiceError(409, 'UPLOAD_PATH_UNSAFE', 'Final upload path is unsafe')
    }
    if (await findSymlinkInPath(storageDir, finalPath, fileSystem)) {
      throw new UploadServiceError(409, 'UPLOAD_PATH_UNSAFE', 'Final upload path contains a symlink')
    }
    const tempStat = await lstatOrNull(fileSystem, tempPath)
    const finalStat = await lstatOrNull(fileSystem, finalPath)
    if (tempStat?.isSymbolicLink() || finalStat?.isSymbolicLink()) {
      throw new UploadServiceError(409, 'UPLOAD_PATH_UNSAFE', 'Upload finalization path is a symlink')
    }
    if (!finalStat?.isFile()) {
      if (!tempStat?.isFile()) {
        throw new UploadServiceError(409, 'UPLOAD_RECOVERY_FAILED', 'Upload temp and final files are missing')
      }
      if (tempStat.size !== Number(session.size)) {
        throw new UploadServiceError(409, 'UPLOAD_RECOVERY_FAILED', 'Upload temp file size does not match declared size')
      }
      if (verifyTempHash) {
        const actualHash = await hashFile(tempPath)
        if (actualHash !== session.video_hash) {
          throw new UploadServiceError(409, 'UPLOAD_RECOVERY_FAILED', 'Upload temp file hash does not match completion metadata')
        }
      }
      await fileSystem.promises.rename(tempPath, finalPath)
      await syncDirectory(fileSystem, path.dirname(finalPath))
    } else {
      if (finalStat.size !== Number(session.size)) {
        throw new UploadServiceError(409, 'UPLOAD_RECOVERY_FAILED', 'Upload final file size does not match declared size')
      }
      const actualHash = await hashFile(finalPath)
      if (actualHash !== session.video_hash) {
        throw new UploadServiceError(409, 'UPLOAD_RECOVERY_FAILED', 'Upload final file hash does not match completion metadata')
      }
      if (tempStat?.isFile()) await fileSystem.promises.unlink(tempPath)
    }
    const completedAt = nowIso(now)
    const affected = await db.runAffected("UPDATE upload_sessions SET status = 'completed', last_activity_at = ?, expires_at = NULL WHERE id = ? AND status = 'completing' AND storage_key = ?", [completedAt, session.id, storageKey], { op: 'complete.upload_session' })
    if (affected !== 1) {
      const current = await db.queryOne('SELECT * FROM upload_sessions WHERE id = ?', [session.id])
      if (current?.status === 'completed') return current
      throw new UploadServiceError(409, 'UPLOAD_STATE_CHANGED', 'Upload state changed during completion')
    }
    return db.queryOne('SELECT * FROM upload_sessions WHERE id = ?', [session.id])
  }

  async function expirePending(session) {
    const removed = await removeCanonicalTemp(session.id)
    await db.runAffected("UPDATE upload_sessions SET status = 'expired', last_activity_at = ? WHERE id = ? AND status = 'pending'", [nowIso(now), session.id], { op: 'expire.upload_session' })
    if (!removed) logger.warn(JSON.stringify({ event: 'upload_temp_not_removed', uploadId: shortId(session.id) }))
  }

  async function createSession({ userId, filename, size, mime }) {
    let createdId = null
    try {
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
        throw new UploadServiceError(400, 'INVALID_UPLOAD_SIZE', 'size must be a positive safe integer', { field: 'size' })
      }
      if (size > MAX_SIZE) {
        throw new UploadServiceError(413, 'PAYLOAD_TOO_LARGE', 'File exceeds the 2GB resumable upload limit')
      }
      if (typeof filename !== 'string' || !filename.trim()) {
        throw new UploadServiceError(400, 'VALIDATION', 'filename is required', { field: 'filename' })
      }
      const media = validateVideoMetadata({ filename, mime })
      const id = uuid()
      if (!isUuid(id)) throw new Error('Generated upload id is invalid')
      createdId = id
      const timestamp = nowIso(now)
      const expiresAt = new Date(now() + ttlMs).toISOString()
      const tmpPath = `tmp/upload_sessions/${id}/blob`
      const session = await db.insert('upload_sessions', {
        id,
        user_id: userId,
        filename: media.filename,
        size,
        mime: media.mime,
        tmp_path: tmpPath,
        bytes_received: 0,
        status: 'pending',
        storage_key: null,
        video_hash: null,
        last_activity_at: timestamp,
        expires_at: expiresAt,
      }, { op: 'create.upload_session' })
      const directory = await sessionDirPath(session.id, { create: true })
      const filePath = path.join(directory, 'blob')
      await fileSystem.promises.writeFile(filePath, Buffer.alloc(0), { flag: 'wx' })
      return { uploadId: session.id, chunkSize: CHUNK_SIZE }
    } catch (error) {
      if (createdId) {
        await removeCanonicalTemp(createdId).catch(() => {})
        await db.runAffected("UPDATE upload_sessions SET status = 'expired', last_activity_at = ? WHERE id = ? AND status = 'pending'", [nowIso(now), createdId], { op: 'expire.failed_upload_session' }).catch(() => {})
      }
      if (error instanceof UploadServiceError || error instanceof MediaValidationError) throw error
      logger.error(JSON.stringify({ event: 'upload_create_failed', reason: error?.code || error?.name || 'Error' }))
      throw new UploadServiceError(500, 'INTERNAL_ERROR', 'Internal server error')
    }
  }

  async function getOwnedSession({ id, userId }) {
    try {
      return await withSessionLock(id, async () => {
        const session = assertOwnedSession(await loadOwnedSession({ id, userId }))
        if (session.status === 'pending' && isExpired(session, now)) {
          await expirePending(session)
          throw new UploadServiceError(410, 'UPLOAD_EXPIRED', 'Upload session has expired')
        }
        return session
      })
    } catch (error) {
      if (error instanceof UploadServiceError || error instanceof MediaValidationError) throw error
      logger.error(JSON.stringify({ event: 'upload_head_failed', uploadId: shortId(id), reason: error?.code || error?.name || 'Error' }))
      throw new UploadServiceError(500, 'INTERNAL_ERROR', 'Internal server error')
    }
  }

  async function appendChunk({ id, userId, offset, chunk }) {
    const startedAt = Date.now()
    try {
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new UploadServiceError(400, 'INVALID_OFFSET', 'offset must be a non-negative safe integer', { field: 'offset' })
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || [])
      if (!buffer.length) throw new UploadServiceError(400, 'EMPTY_CHUNK', 'Empty chunk')
      if (buffer.length > CHUNK_SIZE) {
        throw new UploadServiceError(413, 'CHUNK_TOO_LARGE', 'Chunk exceeds the 8MB protocol limit')
      }
      return await withSessionLock(id, async ({ lockWaitMs }) => {
        const session = assertOwnedSession(await loadOwnedSession({ id, userId }))
        if (session.status === 'pending' && isExpired(session, now)) {
          await expirePending(session)
          throw new UploadServiceError(410, 'UPLOAD_EXPIRED', 'Upload session has expired')
        }
        assertPending(session)
        const received = Number(session.bytes_received) || 0
        if (offset !== received) {
          throw new UploadServiceError(409, 'OFFSET_MISMATCH', `Offset mismatch: server has ${received}, client sent ${offset}`, { expectedOffset: received })
        }
        const remaining = Number(session.size) - received
        if (buffer.length > remaining) {
          throw new UploadServiceError(413, 'CHUNK_EXCEEDS_REMAINING_SIZE', 'Chunk exceeds the declared remaining size')
        }
        const { filePath } = await ensureTempBlob(session)
        const handle = await fileSystem.promises.open(filePath, 'r+')
        try {
          const { bytesWritten } = await handle.write(buffer, 0, buffer.length, received)
          if (bytesWritten !== buffer.length) throw new Error('Short upload file write')
          await handle.sync()
        } finally {
          await handle.close()
        }
        const nextReceived = received + buffer.length
        const timestamp = nowIso(now)
        const expiresAt = new Date(now() + ttlMs).toISOString()
        const tmpPath = `tmp/upload_sessions/${session.id}/blob`
        const affected = await db.runAffected("UPDATE upload_sessions SET bytes_received = ?, tmp_path = ?, last_activity_at = ?, expires_at = ? WHERE id = ? AND user_id = ? AND status = 'pending' AND bytes_received = ?", [nextReceived, tmpPath, timestamp, expiresAt, session.id, userId, received], { op: 'update.upload_session_offset' })
        if (affected !== 1) throw new UploadServiceError(409, 'UPLOAD_STATE_CHANGED', 'Upload state changed while writing the chunk')
        logger.info(JSON.stringify({ event: 'upload_chunk', uploadId: shortId(session.id), offset, bytes: buffer.length, lockWaitMs, writeMs: Date.now() - startedAt }))
        return { received: nextReceived, expiresAt }
      })
    } catch (error) {
      if (error instanceof UploadServiceError || error instanceof MediaValidationError) throw error
      logger.error(JSON.stringify({ event: 'upload_chunk_failed', uploadId: shortId(id), durationMs: Date.now() - startedAt, reason: error?.code || error?.name || 'Error' }))
      throw new UploadServiceError(500, 'INTERNAL_ERROR', 'Internal server error')
    }
  }

  async function complete({ id, userId }) {
    const startedAt = Date.now()
    try {
      return await withSessionLock(id, async ({ lockWaitMs }) => {
        let session = assertOwnedSession(await loadOwnedSession({ id, userId }))
        if (session.status === 'completed') {
          if (!session.storage_key || !STORAGE_KEY_RE.test(session.storage_key)) {
            throw new UploadServiceError(409, 'UPLOAD_RECOVERY_FAILED', 'Completed upload has an invalid storage key')
          }
          await ensureUploadDirectory('uploads')
          const finalPath = path.join(storageDir, session.storage_key)
          if (!containedPath(storageDir, finalPath)) {
            throw new UploadServiceError(409, 'UPLOAD_PATH_UNSAFE', 'Completed upload path is unsafe')
          }
          if (await findSymlinkInPath(storageDir, finalPath, fileSystem)) {
            throw new UploadServiceError(409, 'UPLOAD_PATH_UNSAFE', 'Completed upload path contains a symlink')
          }
          const finalStat = await lstatOrNull(fileSystem, finalPath)
          if (!finalStat?.isFile() || finalStat.isSymbolicLink() || finalStat.size !== Number(session.size)) {
            throw new UploadServiceError(409, 'UPLOAD_RECOVERY_FAILED', 'Completed upload file is missing or unsafe')
          }
          const actualHash = await hashFile(finalPath)
          if (session.video_hash && actualHash !== session.video_hash) {
            throw new UploadServiceError(409, 'UPLOAD_RECOVERY_FAILED', 'Completed upload file hash does not match metadata')
          }
          if (!session.video_hash) {
            await db.runAffected("UPDATE upload_sessions SET video_hash = ? WHERE id = ? AND status = 'completed'", [actualHash, session.id], { op: 'repair.upload_hash' })
            session = await db.queryOne('SELECT * FROM upload_sessions WHERE id = ?', [session.id])
          }
          return responseFor(session)
        }
        if (session.status === 'expired') throw new UploadServiceError(410, 'UPLOAD_EXPIRED', 'Upload session has expired')
        if (session.status === 'pending' && isExpired(session, now)) {
          await expirePending(session)
          throw new UploadServiceError(410, 'UPLOAD_EXPIRED', 'Upload session has expired')
        }
        if (session.status === 'pending') {
          assertPending(session)
          if (Number(session.bytes_received) !== Number(session.size)) {
            throw new UploadServiceError(409, 'INCOMPLETE_UPLOAD', `Incomplete upload: ${session.bytes_received}/${session.size} bytes`, { expectedOffset: session.bytes_received })
          }
          const { filePath } = await ensureTempBlob(session)
          await validateStoredMedia(filePath, session)
          const videoHash = await hashFile(filePath)
          const storageKey = `uploads/${uuid()}${path.extname(session.filename).toLowerCase()}`
          const timestamp = nowIso(now)
          const claimed = await db.runAffected("UPDATE upload_sessions SET status = 'completing', storage_key = ?, video_hash = ?, last_activity_at = ? WHERE id = ? AND user_id = ? AND status = 'pending' AND bytes_received = ?", [storageKey, videoHash, timestamp, session.id, userId, session.size], { op: 'claim.upload_completion' })
          if (claimed !== 1) {
            session = assertOwnedSession(await loadOwnedSession({ id, userId }))
            if (session.status === 'completed') return responseFor(session)
            if (session.status !== 'completing') throw new UploadServiceError(409, 'UPLOAD_STATE_CHANGED', 'Upload state changed during completion claim')
          } else {
            session = assertOwnedSession(await loadOwnedSession({ id, userId }))
          }
        }
        if (session.status !== 'completing') throw new UploadServiceError(409, 'UPLOAD_NOT_PENDING', 'Upload session cannot be completed')
        const completed = await finalizeCompleting(session)
        logger.info(JSON.stringify({ event: 'upload_complete', uploadId: shortId(session.id), lockWaitMs, completionMs: Date.now() - startedAt }))
        return responseFor(completed)
      })
    } catch (error) {
      if (error instanceof UploadServiceError || error instanceof MediaValidationError) throw error
      logger.error(JSON.stringify({ event: 'upload_complete_failed', uploadId: shortId(id), durationMs: Date.now() - startedAt, reason: error?.code || error?.name || 'Error' }))
      throw new UploadServiceError(500, 'INTERNAL_ERROR', 'Internal server error')
    }
  }

  async function recoverUploadSessions() {
    const rows = await db.query ? await db.query("SELECT * FROM upload_sessions WHERE status = 'completing'") : []
    let recovered = 0
    let failed = 0
    for (const row of rows) {
      try {
        await withSessionLock(row.id, async () => {
          const current = assertOwnedSession(await loadOwnedSession({ id: row.id, userId: row.user_id }))
          if (current.status !== 'completing') return
          await finalizeCompleting(current, { verifyTempHash: true })
        })
        recovered += 1
      } catch (error) {
        failed += 1
        logger.error(JSON.stringify({ event: 'upload_recovery_failed', uploadId: shortId(row.id), code: error?.code || 'INTERNAL_ERROR' }))
      }
    }
    logger.info(JSON.stringify({ event: 'upload_recovery', recovered, failed }))
    return { recovered, failed }
  }

  async function cleanupExpiredUploadSessions() {
    const queryMethod = db.query
    if (typeof queryMethod !== 'function') return { seen: 0, cleaned: 0, failed: 0, recovered: 0 }
    const rows = await queryMethod.call(db, "SELECT * FROM upload_sessions WHERE status IN ('pending', 'completing') AND expires_at IS NOT NULL AND expires_at < ?", [nowIso(now)])
    let cleaned = 0
    let failed = 0
    let recovered = 0
    for (const row of rows) {
      if (!isUuid(row.id)) {
        await db.runAffected("UPDATE upload_sessions SET status = 'expired', last_activity_at = ? WHERE id = ? AND status IN ('pending', 'completing')", [nowIso(now), row.id], { op: 'expire.invalid_upload_session' })
        failed += 1
        logger.warn(JSON.stringify({ event: 'upload_invalid_session_id', uploadId: shortId(row.id) }))
        continue
      }
      try {
        await withSessionLock(row.id, async () => {
          const session = await loadOwnedSession({ id: row.id, userId: row.user_id })
          if (!session || !isExpired(session, now) || session.status === 'completed') return
          if (session.status === 'completing') {
            try {
              await finalizeCompleting(session, { verifyTempHash: true })
              recovered += 1
              return
            } catch (error) {
              logger.error(JSON.stringify({ event: 'upload_expired_recovery_failed', uploadId: shortId(session.id), code: error?.code || 'INTERNAL_ERROR' }))
            }
          }
          const removed = await removeCanonicalTemp(session.id)
          await db.runAffected("UPDATE upload_sessions SET status = 'expired', last_activity_at = ? WHERE id = ? AND status IN ('pending', 'completing')", [nowIso(now), session.id], { op: 'expire.upload_session' })
          if (removed) cleaned += 1
          else failed += 1
        })
      } catch (error) {
        failed += 1
        logger.error(JSON.stringify({ event: 'upload_cleanup_failed', uploadId: shortId(row.id), code: error?.code || 'INTERNAL_ERROR' }))
      }
    }
    logger.info(JSON.stringify({ event: 'upload_cleanup', seen: rows.length, cleaned, failed, recovered }))
    return { seen: rows.length, cleaned, failed, recovered }
  }

  return {
    CHUNK_SIZE,
    MAX_SIZE,
    createSession,
    getOwnedSession,
    appendChunk,
    complete,
    recoverUploadSessions,
    cleanupExpiredUploadSessions,
    withSessionLock,
  }
}

export const resumableUploadService = createResumableUploadService()

export default resumableUploadService
