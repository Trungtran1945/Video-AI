import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { findSymlinkInPath } from '../lib/safePath.js'

const SAFE_ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}'
const VIDEO_EXTENSIONS = 'mp4|m4v|mov|mkv|webm'
const ALLOWED_PATHS = [
  new RegExp(`^uploads/${SAFE_ID}\\.(${VIDEO_EXTENSIONS})$`, 'i'),
  new RegExp(`^outputs/${SAFE_ID}\\.mp4$`, 'i'),
  new RegExp(`^outputs/thumbs/${SAFE_ID}\\.jpg$`, 'i'),
  new RegExp(`^projects/${SAFE_ID}/final\\.(mp4|mkv)$`, 'i'),
  new RegExp(`^projects/${SAFE_ID}/thumb\\.jpg$`, 'i'),
]

function canonicalType(relativePath) {
  const extension = path.posix.extname(relativePath).toLowerCase()
  if (extension === '.jpg') return 'image/jpeg'
  if (extension === '.mp4') return 'video/mp4'
  if (extension === '.m4v') return 'video/x-m4v'
  if (extension === '.mov') return 'video/quicktime'
  if (extension === '.mkv') return 'video/x-matroska'
  if (extension === '.webm') return 'video/webm'
  return null
}

function safeRelativePath(requestPath) {
  let decoded
  try {
    decoded = decodeURIComponent(requestPath)
  } catch (_) {
    return null
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null
  const relative = decoded.replace(/^\/+/, '')
  if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) return null
  return ALLOWED_PATHS.some((pattern) => pattern.test(relative)) ? relative : null
}

export function createSafeMediaStatic({ storageDir, fileSystem = fs } = {}) {
  if (!storageDir) throw new Error('storageDir is required')
  const root = path.resolve(storageDir)
  const staticFiles = express.static(root, {
    dotfiles: 'deny',
    index: false,
    redirect: false,
    fallthrough: false,
    follow: false,
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Disposition', 'inline')
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    },
  })

  return async (req, res, next) => {
    const relative = safeRelativePath(req.path)
    if (!relative) return res.status(404).end()
    const absolute = path.resolve(root, ...relative.split('/'))
    const containment = path.relative(root, absolute)
    if (!containment || containment.startsWith('..') || path.isAbsolute(containment)) {
      return res.status(404).end()
    }
    try {
      if (await findSymlinkInPath(root, absolute, fileSystem)) return res.status(404).end()
      const stat = await fileSystem.promises.lstat(absolute)
      if (stat.isSymbolicLink() || !stat.isFile()) return res.status(404).end()
    } catch (error) {
      if (error?.code === 'ENOENT') return next()
      return next(error)
    }
    res.setHeader('Content-Type', canonicalType(relative))
    return staticFiles(req, res, next)
  }
}

export default createSafeMediaStatic
