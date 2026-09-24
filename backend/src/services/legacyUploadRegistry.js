import fs from 'node:fs'
import path from 'node:path'
import { findSymlinkInPath, isPathInside } from '../lib/safePath.js'

const activeLegacyUploads = new Set()

export function markLegacyUploadActive(filePath) {
  if (filePath) activeLegacyUploads.add(path.resolve(filePath))
}

export function releaseLegacyUpload(filePath) {
  if (filePath) activeLegacyUploads.delete(path.resolve(filePath))
}

export async function cleanupLegacyUploads({
  root,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  fileSystem = fs,
  trustedRoot = path.dirname(root),
  now = Date.now,
  logger = console,
} = {}) {
  const absoluteRoot = path.resolve(root)
  const absoluteTrustedRoot = path.resolve(trustedRoot)
  if (!isPathInside(absoluteTrustedRoot, absoluteRoot) || await findSymlinkInPath(absoluteTrustedRoot, absoluteRoot, fileSystem)) {
    logger.warn(JSON.stringify({ event: 'legacy_upload_root_rejected' }))
    return { seen: 0, cleaned: 0, skipped: 1 }
  }
  let rootStat
  try {
    rootStat = await fileSystem.promises.lstat(absoluteRoot)
  } catch (error) {
    if (error?.code === 'ENOENT') return { seen: 0, cleaned: 0, skipped: 0 }
    throw error
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    logger.warn(JSON.stringify({ event: 'legacy_upload_root_rejected' }))
    return { seen: 0, cleaned: 0, skipped: 1 }
  }
  let entries
  try {
    entries = await fileSystem.promises.readdir(absoluteRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { seen: 0, cleaned: 0, skipped: 0 }
    throw error
  }
  let cleaned = 0
  let skipped = 0
  let seen = 0
  for (const entry of entries) {
    const filePath = path.join(absoluteRoot, entry.name)
    seen += 1
    if (activeLegacyUploads.has(path.resolve(filePath))) {
      skipped += 1
      continue
    }
    let stat
    try {
      stat = await fileSystem.promises.lstat(filePath)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        skipped += 1
        continue
      }
      throw error
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      skipped += 1
      continue
    }
    if (now() - stat.mtimeMs <= maxAgeMs) {
      skipped += 1
      continue
    }
    try {
      await fileSystem.promises.unlink(filePath)
      cleaned += 1
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      skipped += 1
    }
  }
  return { seen, cleaned, skipped }
}
