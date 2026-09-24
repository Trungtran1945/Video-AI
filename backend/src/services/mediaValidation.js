import fs from 'node:fs/promises'
import path from 'node:path'

const VIDEO_FORMATS = new Map([
  ['.mp4', { mime: 'video/mp4', aliases: ['video/mp4'], container: 'isobmff' }],
  ['.m4v', { mime: 'video/x-m4v', aliases: ['video/x-m4v', 'video/mp4'], container: 'isobmff' }],
  ['.mov', { mime: 'video/quicktime', aliases: ['video/quicktime', 'video/mp4'], container: 'isobmff' }],
  ['.mkv', { mime: 'video/x-matroska', aliases: ['video/x-matroska', 'video/matroska'], container: 'ebml' }],
  ['.webm', { mime: 'video/webm', aliases: ['video/webm'], container: 'ebml' }],
])

export class MediaValidationError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.name = 'MediaValidationError'
    this.statusCode = 415
    this.code = 'UNSUPPORTED_MEDIA_TYPE'
    this.extra = extra
  }
}

export function canonicalVideoMimeType(extension) {
  return VIDEO_FORMATS.get(String(extension || '').toLowerCase())?.mime || null
}

export function isCanonicalVideoExtension(extension) {
  return VIDEO_FORMATS.has(String(extension || '').toLowerCase())
}

export function validateVideoMetadata({ filename, mime } = {}) {
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 255) {
    throw new MediaValidationError('Invalid video filename', { field: 'filename' })
  }
  const normalizedName = filename.trim()
  if (path.basename(normalizedName) !== normalizedName || /[\\/]/.test(normalizedName)) {
    throw new MediaValidationError('Video filename must be a basename', { field: 'filename' })
  }
  const extension = path.extname(normalizedName).toLowerCase()
  const format = VIDEO_FORMATS.get(extension)
  if (!format) {
    throw new MediaValidationError('Unsupported video extension', { field: 'filename', extension })
  }
  const normalizedMime = String(mime || '').split(';')[0].trim().toLowerCase()
  if (!format.aliases.includes(normalizedMime)) {
    throw new MediaValidationError('Unsupported video MIME type', { field: 'mime' })
  }
  return {
    filename: normalizedName,
    extension,
    mime: format.mime,
    container: format.container,
  }
}

export async function assertVideoFile(filePath, extension, { probe = null } = {}) {
  const format = VIDEO_FORMATS.get(String(extension || '').toLowerCase())
  if (!format) throw new MediaValidationError('Unsupported video extension', { extension })
  const handle = await fs.open(filePath, 'r')
  let header
  try {
    header = Buffer.alloc(16)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    header = header.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  const isIsoBmff = header.length >= 12 && header.toString('ascii', 4, 8) === 'ftyp'
  const isEbml = header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  if ((format.container === 'isobmff' && !isIsoBmff) || (format.container === 'ebml' && !isEbml)) {
    throw new MediaValidationError('File content does not match the video extension', { extension })
  }
  let metadata = null
  if (probe) {
    try {
      metadata = await probe(filePath)
    } catch (_) {
      throw new MediaValidationError('FFprobe could not validate the video stream', { extension })
    }
    if (metadata?.available !== false && !metadata?.codec) {
      throw new MediaValidationError('FFprobe found no video stream', { extension })
    }
  }
  return metadata
}
