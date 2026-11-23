// Single source of truth cho API origin (Item 7 — prod khác origin).
// Dev (VITE_API_BASE rỗng → '/api/v1'): giữ behavior cũ 100% (relative +
// Vite proxy). Prod (VITE_API_BASE=https://api...): suy absolute origin.
const RAW = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE) || '/api/v1'

export function getApiBase() {
  return RAW.replace(/\/$/, '')
}

export function getApiOrigin() {
  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'
    return new URL(getApiBase(), base).origin
  } catch {
    return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'
  }
}

export function resolveStorageUrl(keyOrObject) {
  if (!keyOrObject) return null

  // Support passing object (e.g. project.output, asset)
  let rawKey = keyOrObject
  if (typeof keyOrObject === 'object') {
    rawKey = keyOrObject.secure_url || keyOrObject.secureUrl || keyOrObject.url || keyOrObject.storage_key || keyOrObject.storageKey || keyOrObject.key
    if (!rawKey) return null
  }

  const trimmed = String(rawKey).trim()
  if (!trimmed) return null

  // Blob and data URLs
  if (/^(blob|data):/i.test(trimmed)) return trimmed

  const k = trimmed.replace(/^\//, '')

  // Full URLs (e.g. Cloudinary https://res.cloudinary.com/... or HTTP)
  if (/^https?:\/\//i.test(k)) return k

  const path = k.startsWith('storage/') ? k : `storage/${k}`
  // Same-origin dev (base relative) → relative để ăn Vite proxy + nginx proxy.
  if (getApiBase().startsWith('/')) return `/${path}`
  return `${getApiOrigin()}/${path}`
}

export function appendCacheBuster(url, version) {
  if (!url || version == null || version === '') return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}v=${encodeURIComponent(version)}`
}

export function isCloudinaryUrl(url) {
  return typeof url === 'string' && /res\.cloudinary\.com/i.test(url)
}

/**
 * Returns a URL configured for direct browser file attachment/download.
 * For Cloudinary URLs, injects the fl_attachment transformation flag so
 * Cloudinary responds with Content-Disposition: attachment headers,
 * bypassing browser cross-origin download restrictions.
 */
export function getMediaDownloadUrl(url, filename) {
  if (!url || typeof url !== 'string') return url
  if (isCloudinaryUrl(url)) {
    if (url.includes('/fl_attachment')) return url
    if (url.includes('/upload/')) {
      const flag = filename
        ? `fl_attachment:${encodeURIComponent(filename.replace(/\.[^/.]+$/, ''))}`
        : 'fl_attachment'
      return url.replace('/upload/', `/upload/${flag}/`)
    }
  }
  return url
}

/**
 * Programmatically downloads media file with cross-origin resilience.
 */
export async function downloadMedia(url, filename = 'video.mp4') {
  if (!url) return
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const blobUrl = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    window.URL.revokeObjectURL(blobUrl)
  } catch {
    const dlUrl = getMediaDownloadUrl(url, filename)
    const a = document.createElement('a')
    a.href = dlUrl
    a.download = filename
    a.target = '_blank'
    a.rel = 'noreferrer'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }
}

/**
 * Resolves a thumbnail image URL for an asset, output, or media URL.
 * Automatically transforms Cloudinary video URLs into JPEG snapshot poster frames.
 */
export function getMediaThumbnailUrl(itemOrUrl) {
  if (!itemOrUrl) return null

  if (typeof itemOrUrl === 'object') {
    const explicitThumb = itemOrUrl.thumbnail_url || itemOrUrl.thumbnailUrl
    if (explicitThumb) return resolveStorageUrl(explicitThumb)
    const thumbKey = itemOrUrl.thumbnail_key || itemOrUrl.thumbnailKey
    if (thumbKey) return resolveStorageUrl(thumbKey)
    if (itemOrUrl.kind === 'image') return resolveStorageUrl(itemOrUrl)
  }

  const mediaUrl = resolveStorageUrl(itemOrUrl)
  if (!mediaUrl) return null

  if (isCloudinaryUrl(mediaUrl)) {
    // If it's a Cloudinary video, derive a jpg frame snapshot
    if (/\.(mp4|webm|mov|mkv)(\?.*)?$/i.test(mediaUrl)) {
      return mediaUrl.replace(/\.(mp4|webm|mov|mkv)(\?.*)?$/i, '.jpg$2')
    }
    if (mediaUrl.includes('/video/upload/')) {
      return mediaUrl.replace('/video/upload/', '/video/upload/so_0/').replace(/\.[a-z0-9]+(\?.*)?$/i, '.jpg$1')
    }
  }

  return null
}

export function isMediaVideo(item) {
  if (!item) return false
  if (typeof item === 'string') {
    return /\.(mp4|webm|mov|m4v|mkv)(\?.*)?$/i.test(item)
  }
  const resType = item.resource_type || item.resourceType
  if (resType === 'video') return true
  const format = String(item.format || '').toLowerCase()
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv'].includes(format)) return true
  const mime = item.mimeType || item.mime_type
  if (typeof mime === 'string' && mime.startsWith('video/')) return true
  if (item.kind === 'video') return true
  const urlOrKey = item.secure_url || item.secureUrl || item.url || item.storage_key || item.storageKey || item.key
  if (typeof urlOrKey === 'string' && /\.(mp4|webm|mov|m4v|mkv)(\?.*)?$/i.test(urlOrKey)) return true
  return false
}

export function isMediaAudio(item) {
  if (!item) return false
  if (typeof item === 'string') {
    return /\.(mp3|wav|ogg|m4a|aac|flac)(\?.*)?$/i.test(item)
  }
  const resType = item.resource_type || item.resourceType
  if (resType === 'audio') return true
  const format = String(item.format || '').toLowerCase()
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(format)) return true
  const mime = item.mimeType || item.mime_type
  if (typeof mime === 'string' && mime.startsWith('audio/')) return true
  if (['voiceover', 'music', 'bgm', 'sfx', 'audio'].includes(item.kind)) return true
  const urlOrKey = item.secure_url || item.secureUrl || item.url || item.storage_key || item.storageKey || item.key
  if (typeof urlOrKey === 'string' && /\.(mp3|wav|ogg|m4a|aac|flac)(\?.*)?$/i.test(urlOrKey)) return true
  return false
}

export function resolveSseUrl(projectId, ticket) {
  return `${getApiBase()}/projects/${projectId}/events?ticket=${encodeURIComponent(ticket)}`
}

// '/health' | '/ready' nằm ở root server (không dưới /api/v1).
export function resolveSystemPath(p) {
  if (getApiBase().startsWith('/')) return p // dev: Vite proxy /health → :3001
  // Prod cross-origin: health nằm cùng origin API, strip trailing /api/v1.
  const base = getApiBase().replace(/\/api\/v1\/?$/, '')
  return `${base}${p}`
}
