import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { findSymlinkInPath, isPathInside } from '../lib/safePath.js'

const SAFE_ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}'
const VIDEO_EXTENSIONS = 'mp4|m4v|mov|mkv|webm'
const MEDIA_EXTENSIONS = 'mp4|m4v|mov|mkv|webm|avi|jpg|jpeg|png|webp|gif|bmp|mp3|wav|ogg|m4a|aac|flac'
const ALLOWED_PATHS = [
  new RegExp(`^uploads/${SAFE_ID}\\.(${VIDEO_EXTENSIONS})$`, 'i'),
  new RegExp(`^outputs/${SAFE_ID}\\.mp4$`, 'i'),
  new RegExp(`^outputs/thumbs/${SAFE_ID}\\.jpg$`, 'i'),
  new RegExp(`^projects/${SAFE_ID}/final\\.(mp4|mkv)$`, 'i'),
  new RegExp(`^projects/${SAFE_ID}/thumb\\.jpg$`, 'i'),
  new RegExp(`^projects/${SAFE_ID}/assets/${SAFE_ID}\\.(${MEDIA_EXTENSIONS})$`, 'i'),
]

function canonicalType(relativePath) {
  const extension = path.posix.extname(relativePath).toLowerCase()
  switch (extension) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.bmp':
      return 'image/bmp'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.ogg':
      return 'audio/ogg'
    case '.m4a':
      return 'audio/mp4'
    case '.aac':
      return 'audio/aac'
    case '.flac':
      return 'audio/flac'
    case '.mp4':
      return 'video/mp4'
    case '.m4v':
      return 'video/x-m4v'
    case '.mov':
      return 'video/quicktime'
    case '.mkv':
      return 'video/x-matroska'
    case '.webm':
      return 'video/webm'
    case '.avi':
      return 'video/x-msvideo'
    default:
      return null
  }
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
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      res.setHeader('Access-Control-Allow-Origin', '*')
    },
  })

  return async (req, res, next) => {
    const relative = safeRelativePath(req.path)
    if (!relative) return res.status(404).end()
    const absolute = path.resolve(root, ...relative.split('/'))
    if (absolute === root || !isPathInside(root, absolute)) {
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
