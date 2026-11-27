import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { config } from '../config.js'
import { storageService } from '../services/storage/index.js'
import { assertSafeRemoteMediaUrl } from '../services/storage/cloudinaryStorageProvider.js'
import { tmpDirOf, resolveStorageKey } from './context.js'
import { isPathInside, resolveSafePath } from '../lib/safePath.js'

/**
 * Creates a unique, job-scoped staging manager for a pipeline stage.
 * Staged files are tracked and cleaned up on success, failure, or cancellation.
 */
export function createJobStagingContext(projectId, stageName = 'stage', options = {}) {
  const storage = options.storage || storageService
  const jobUuid = uuidv4()
  const stagingRoot = options.storageDir ? path.join(options.storageDir, 'tmp', projectId) : tmpDirOf(projectId)
  const stagingDir = path.join(stagingRoot, 'staged', `${stageName}_${jobUuid}`)
  const stagedFiles = new Set()
  let cleanupPromise = null

  async function ensureStagingDirectory() {
    await fs.promises.mkdir(stagingDir, { recursive: true })
    return stagingDir
  }

  async function stageFile(keyOrUrl, filenameHint = null) {
    if (!keyOrUrl) throw new Error('Cannot stage media: key or URL is empty')

    const allowedLocalRoot = options.allowLocalDir || options.storageDir || config.storageDir

    // If keyOrUrl is an absolute path, strictly confine it to allowedLocalRoot (never read arbitrary host files)
    if (typeof keyOrUrl === 'string' && path.isAbsolute(keyOrUrl)) {
      if (!isPathInside(allowedLocalRoot, keyOrUrl)) {
        throw new Error(`Unsafe media staging path outside storage directory: ${path.basename(keyOrUrl)}`)
      }
      if (fs.existsSync(keyOrUrl)) {
        const stat = await fs.promises.stat(keyOrUrl)
        if (stat.isFile() && stat.size > 0) return keyOrUrl
      }
      throw new Error(`Staged local media file not found: ${path.basename(keyOrUrl)}`)
    }

    const isHttpUrl = typeof keyOrUrl === 'string' && /^https?:\/\//i.test(keyOrUrl)
    if (isHttpUrl) {
      assertSafeRemoteMediaUrl(keyOrUrl)
    } else {
      // 1. If key refers to an existing local file inside storageDir, return its absolute path directly
      const localAbs = options.storageDir ? resolveSafePath(options.storageDir, keyOrUrl) : resolveStorageKey(keyOrUrl)
      if (!localAbs) {
        throw new Error(`Unsafe media staging key: ${String(keyOrUrl)}`)
      }
      if (fs.existsSync(localAbs)) {
        const stat = await fs.promises.stat(localAbs)
        if (stat.isFile() && stat.size > 0) {
          return localAbs
        }
      }
    }

    // 2. Otherwise download to the unique job staging directory
    await ensureStagingDirectory()

    const rawExt = path.extname(String(keyOrUrl)).split('?')[0] || '.mp4'
    const safeExt = /^\.[a-z0-9]+$/i.test(rawExt) ? rawExt : '.mp4'
    const baseName = filenameHint ? path.basename(filenameHint, path.extname(filenameHint)) : `asset_${uuidv4().slice(0, 8)}`
    const destPath = path.join(stagingDir, `${baseName}${safeExt}`)

    // Security check: ensure destination path is inside stagingDir
    if (!isPathInside(stagingDir, destPath)) {
      throw new Error(`Unsafe media staging destination path: ${destPath}`)
    }

    await storage.downloadToTemp(keyOrUrl, destPath)

    if (!fs.existsSync(destPath)) {
      throw new Error(`Failed to stage media file to: ${destPath}`)
    }

    const stat = await fs.promises.stat(destPath)
    if (stat.size <= 0) {
      await fs.promises.unlink(destPath).catch(() => {})
      throw new Error(`Staged media file is empty (0 bytes): ${destPath}`)
    }

    stagedFiles.add(destPath)
    return destPath
  }

  async function cleanup() {
    if (cleanupPromise) return cleanupPromise

    cleanupPromise = (async () => {
      for (const file of stagedFiles) {
        try {
          if (fs.existsSync(file)) {
            await fs.promises.unlink(file).catch(() => {})
          }
        } catch (_) {}
      }
      stagedFiles.clear()

      try {
        if (fs.existsSync(stagingDir)) {
          await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
        }
      } catch (_) {}
    })()

    return cleanupPromise
  }

  return {
    jobUuid,
    stagingDir,
    stagedFiles,
    stageFile,
    cleanup,
  }
}

/**
 * Resolves or downloads the project source video to a local path for FFmpeg processing.
 * If ctx contains a stagingContext, stages into it; otherwise checks local storage.
 */
export async function stageSourceMedia(project, ctx = {}) {
  const sourceKey = project?.source_video_key
  const secureUrl = project?.source_secure_url
  const publicId = project?.source_cloudinary_public_id
  const targetIdentifier = secureUrl || publicId || sourceKey

  if (!targetIdentifier) {
    throw new Error('Project has no source video key or URL')
  }

  // 1. Direct local file fast-path
  if (sourceKey) {
    const localAbs = resolveStorageKey(sourceKey)
    if (localAbs && fs.existsSync(localAbs)) {
      const stat = await fs.promises.stat(localAbs)
      if (stat.isFile() && stat.size > 0) {
        return localAbs
      }
    }
  }

  // 2. If ctx has a stagingContext, use it
  if (ctx.stagingContext && typeof ctx.stagingContext.stageFile === 'function') {
    return ctx.stagingContext.stageFile(targetIdentifier, `source_${project.id}`)
  }

  // 3. Fallback: create an ephemeral staging context and register cleanup in ctx
  const staging = createJobStagingContext(project.id, ctx.job?.type || 'media', {
    storageDir: ctx.storageDir,
    allowLocalDir: ctx.allowLocalDir,
    storage: ctx.storage,
  })
  if (ctx.signal) {
    ctx.signal.addEventListener('abort', () => staging.cleanup(), { once: true })
  }
  const stagedPath = await staging.stageFile(targetIdentifier, `source_${project.id}`)

  // Store in ctx for downstream cleanup if possible
  if (Array.isArray(ctx.ephemeralStaging)) {
    ctx.ephemeralStaging.push(staging)
  }

  return stagedPath
}

export default {
  createJobStagingContext,
  stageSourceMedia,
}
