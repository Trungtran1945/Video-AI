export const SUPPORTED_VIDEO_EXTENSIONS = Object.freeze(['.mp4', '.mov', '.m4v', '.mkv', '.webm'])
export const MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024

const VIDEO_MIME_TYPES = Object.freeze({
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
})

export function videoExtension(filename) {
  const name = String(filename || '')
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

export function canonicalVideoMimeType(extension) {
  return VIDEO_MIME_TYPES[String(extension || '').toLowerCase()] || ''
}

export function validateVideoFileSelection(file) {
  if (!file || typeof file.name !== 'string' || !file.name || file.name.includes('/') || file.name.includes('\\')) {
    throw new Error('Tên tệp video không hợp lệ')
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error('Tệp video rỗng hoặc kích thước không hợp lệ')
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new Error('File vượt quá giới hạn 2GB')
  }
  const extension = videoExtension(file.name)
  if (!SUPPORTED_VIDEO_EXTENSIONS.includes(extension)) {
    throw new Error('Chỉ hỗ trợ MP4, MOV, M4V, MKV và WebM')
  }
  return { extension, mime: canonicalVideoMimeType(extension) }
}

export const VIDEO_ACCEPT = [...SUPPORTED_VIDEO_EXTENSIONS, 'video/mp4', 'video/quicktime', 'video/x-m4v', 'video/x-matroska', 'video/webm'].join(',')
