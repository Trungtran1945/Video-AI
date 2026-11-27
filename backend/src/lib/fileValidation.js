import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isPathInside } from './safePath.js'

/**
 * OWASP ASVS L2 File Upload Validation and Security Helpers.
 * Provides unified file signature (magic byte) detection, executable/malicious
 * file rejection, size limit enforcement, path traversal protection, and safe filename generation.
 */

export class FileValidationError extends Error {
  constructor(message, { statusCode = 400, code = 'FILE_VALIDATION_ERROR', extra = {} } = {}) {
    super(message)
    this.name = 'FileValidationError'
    this.statusCode = statusCode
    this.code = code
    this.extra = extra
  }
}

export const FILE_SIZE_LIMITS = Object.freeze({
  VIDEO: 2 * 1024 * 1024 * 1024,      // 2GB
  AUDIO: 200 * 1024 * 1024,           // 200MB
  IMAGE: 20 * 1024 * 1024,            // 20MB
  SUBTITLE: 10 * 1024 * 1024,         // 10MB
  SCRIPT: 2 * 1024 * 1024,            // 2MB
  CHUNK: 10 * 1024 * 1024,            // 10MB
  COMPOSER_ASSET: 500 * 1024 * 1024,  // 500MB
  LEGACY_UPLOAD: 50 * 1024 * 1024,    // 50MB
})

export const ALLOWED_EXTENSIONS_BY_TYPE = Object.freeze({
  video: new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi']),
  audio: new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']),
  image: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg']),
  subtitle: new Set(['.srt', '.vtt', '.ass', '.ssa']),
  script: new Set(['.txt', '.md']),
})

export const EXTENSION_MIME_MAP = Object.freeze({
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.srt': 'text/plain',
  '.vtt': 'text/vtt',
  '.ass': 'text/x-ssa',
  '.ssa': 'text/x-ssa',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
})

/**
 * Checks if a buffer begins with or contains dangerous/executable signatures.
 * Detects: Windows PE (.exe, .dll, .ocx), Linux ELF, macOS Mach-O, Java class bytecode,
 * Windows LNK shortcuts, shell shebangs, PHP scripts, and embedded script tags.
 *
 * @param {Buffer} buf - File header buffer (at least 16-64 bytes)
 * @returns {{ dangerous: boolean, reason?: string }}
 */
export function isDangerousSignature(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) {
    return { dangerous: false }
  }

  // Windows PE (MZ header: 4D 5A)
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    return { dangerous: true, reason: 'Windows executable / DLL (MZ header) detected' }
  }

  // Linux ELF (7F 45 4C 46)
  if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    return { dangerous: true, reason: 'Linux ELF binary detected' }
  }

  // Mach-O binary (macOS)
  if (buf.length >= 4) {
    const magic32 = buf.readUInt32BE(0)
    const magic32LE = buf.readUInt32LE(0)
    // 0xFEEDFACE (32-bit), 0xFEEDFACF (64-bit), 0xCAFEBABE (universal fat binary or Java class)
    if (magic32 === 0xfeedface || magic32 === 0xfeedfacf || magic32LE === 0xfeedface || magic32LE === 0xfeedfacf) {
      return { dangerous: true, reason: 'Mach-O binary detected' }
    }
    if (magic32 === 0xcafebabe) {
      return { dangerous: true, reason: 'Java class bytecode / Mach-O universal binary detected' }
    }
  }

  // Shebang script: #! (23 21)
  if (buf[0] === 0x23 && buf[1] === 0x21) {
    return { dangerous: true, reason: 'Executable script (shebang) detected' }
  }

  // Windows Shell Shortcut: .LNK (4C 00 00 00 01 14 02 00)
  if (buf.length >= 8 && buf[0] === 0x4c && buf[1] === 0x00 && buf[2] === 0x00 && buf[3] === 0x00) {
    return { dangerous: true, reason: 'Windows shortcut (.lnk) file detected' }
  }

  // PHP code injection / script tags in header
  const sampleStr = buf.subarray(0, Math.min(buf.length, 512)).toString('latin1').toLowerCase()
  if (sampleStr.includes('<?php') || sampleStr.includes('<?=')) {
    return { dangerous: true, reason: 'PHP script tag detected' }
  }

  return { dangerous: false }
}

/**
 * Detects the media format and type from magic bytes.
 *
 * @param {Buffer} buf - File header buffer (at least 64 bytes recommended)
 * @returns {{ type: 'video'|'audio'|'image'|'subtitle'|'script', format: string, mime: string, ext: string }|null}
 */
export function detectFileSignature(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return null

  const dangerousCheck = isDangerousSignature(buf)
  if (dangerousCheck.dangerous) {
    return { dangerous: true, reason: dangerousCheck.reason }
  }

  const len = buf.length

  // --- IMAGES ---

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (len >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { type: 'image', format: 'png', mime: 'image/png', ext: '.png' }
  }

  // JPEG: FF D8 FF
  if (len >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { type: 'image', format: 'jpeg', mime: 'image/jpeg', ext: '.jpg' }
  }

  // GIF: GIF8 (47 49 46 38)
  if (len >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { type: 'image', format: 'gif', mime: 'image/gif', ext: '.gif' }
  }

  // BMP: BM (42 4D)
  if (len >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { type: 'image', format: 'bmp', mime: 'image/bmp', ext: '.bmp' }
  }

  // RIFF container: WEBP, WAV, AVI
  if (len >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    const riffType = buf.toString('ascii', 8, 12)
    if (riffType === 'WEBP') {
      return { type: 'image', format: 'webp', mime: 'image/webp', ext: '.webp' }
    }
    if (riffType === 'WAVE') {
      return { type: 'audio', format: 'wav', mime: 'audio/wav', ext: '.wav' }
    }
    if (riffType === 'AVI ' || riffType === 'AVIX') {
      return { type: 'video', format: 'avi', mime: 'video/x-msvideo', ext: '.avi' }
    }
    // Fallback RIFF (defaults to generic audio/video if not specified)
    return { type: 'audio', format: 'wav', mime: 'audio/wav', ext: '.wav' }
  }

  // --- AUDIO ---

  // MP3: ID3 header (49 44 33)
  if (len >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return { type: 'audio', format: 'mp3', mime: 'audio/mpeg', ext: '.mp3' }
  }

  // AAC: ADTS frame header (FF F1 or FF F9 or sync word)
  if (len >= 2 && buf[0] === 0xff && (buf[1] === 0xf1 || buf[1] === 0xf9)) {
    return { type: 'audio', format: 'aac', mime: 'audio/aac', ext: '.aac' }
  }

  // MP3: MPEG audio sync frame (FF followed by 111xxxxx with Layer III)
  if (len >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    return { type: 'audio', format: 'mp3', mime: 'audio/mpeg', ext: '.mp3' }
  }

  // FLAC: fLaC (66 4C 61 43)
  if (len >= 4 && buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) {
    return { type: 'audio', format: 'flac', mime: 'audio/flac', ext: '.flac' }
  }

  // OGG: OggS (4F 67 67 53)
  if (len >= 4 && buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
    return { type: 'audio', format: 'ogg', mime: 'audio/ogg', ext: '.ogg' }
  }

  // --- VIDEO & ISOBMFF CONTAINERS ---

  // EBML (MKV / WebM): 1A 45 DF A3
  if (len >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    const ebmlSample = buf.subarray(0, Math.min(len, 128)).toString('latin1').toLowerCase()
    if (ebmlSample.includes('webm')) {
      return { type: 'video', format: 'webm', mime: 'video/webm', ext: '.webm' }
    }
    return { type: 'video', format: 'mkv', mime: 'video/x-matroska', ext: '.mkv' }
  }

  // ISOBMFF: MP4, M4A, MOV (offset 4 is 'ftyp')
  if (len >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12)
    if (brand.trim() === 'M4A' || brand === 'M4A ') {
      return { type: 'audio', format: 'm4a', mime: 'audio/mp4', ext: '.m4a' }
    }
    if (brand === 'qt  ') {
      return { type: 'video', format: 'mov', mime: 'video/quicktime', ext: '.mov' }
    }
    if (brand.trim() === 'M4V') {
      return { type: 'video', format: 'm4v', mime: 'video/x-m4v', ext: '.m4v' }
    }
    return { type: 'video', format: 'mp4', mime: 'video/mp4', ext: '.mp4' }
  }

  // MP4 / QuickTime atoms at the beginning: wide, free, moov, mdat
  const atomSample = buf.subarray(0, Math.min(len, 64)).toString('latin1')
  if (atomSample.includes('wide') || atomSample.includes('free') || atomSample.includes('moov') || atomSample.includes('mdat')) {
    if (atomSample.includes('ftypM4A') || atomSample.includes('M4A ')) {
      return { type: 'audio', format: 'm4a', mime: 'audio/mp4', ext: '.m4a' }
    }
    return { type: 'video', format: 'mp4', mime: 'video/mp4', ext: '.mp4' }
  }

  // --- TEXT / VECTOR / SUBTITLES ---

  const utf8Sample = buf.subarray(0, Math.min(len, 4096)).toString('utf8').replace(/^\uFEFF/, '').trim()

  // SVG: vector image — scan full provided buffer (never truncate SVG XSS checks at 512 bytes)
  if (utf8Sample.startsWith('<svg') || ((utf8Sample.startsWith('<?xml') || utf8Sample.startsWith('<!--')) && utf8Sample.includes('<svg'))) {
    const fullSvgText = buf.toString('utf8')
    if (isUnsafeSvgContent(fullSvgText)) {
      return { dangerous: true, reason: 'Malicious script / event handler detected inside SVG' }
    }
    return { type: 'image', format: 'svg', mime: 'image/svg+xml', ext: '.svg' }
  }

  // WebVTT
  if (utf8Sample.startsWith('WEBVTT')) {
    return { type: 'subtitle', format: 'vtt', mime: 'text/vtt', ext: '.vtt' }
  }

  // Advanced SubStation Alpha (ASS / SSA)
  if (utf8Sample.startsWith('[Script Info]') || utf8Sample.startsWith('\ufeff[Script Info]')) {
    return { type: 'subtitle', format: 'ass', mime: 'text/x-ssa', ext: '.ass' }
  }

  // SubRip (SRT): must have timecode arrow '-->'
  if (/-->/.test(utf8Sample) && /^\d+\s*[\r\n]/.test(utf8Sample)) {
    return { type: 'subtitle', format: 'srt', mime: 'text/plain', ext: '.srt' }
  }

  return null
}

/**
 * Validates a file's signature and consistency with expected metadata.
 * Reads the first 512 bytes of a file on disk or inspects a provided buffer.
 *
 * @param {string|Buffer} filePathOrBuffer - Absolute file path or Buffer
 * @param {object} options
 * @param {string} [options.expectedType] - Expected media type ('video', 'audio', 'image', 'subtitle', 'script')
 * @param {string[]} [options.allowedTypes] - List of permitted media types
 * @param {string} [options.filename] - Original filename to cross-verify extension against magic bytes
 * @param {number} [options.maxBytes] - Maximum allowed file size in bytes
 * @returns {Promise<{ valid: boolean, type: string, format: string, mime: string, ext: string }>}
 */
const DANGEROUS_SVG_RE = /<script\b|javascript:|vbscript:|data:text\/html|\bon\w+\s*=|<foreignobject\b|<iframe\b|<embed\b|<object\b/i

export function isUnsafeSvgContent(svgText) {
  if (typeof svgText !== 'string' || !svgText) return false
  return DANGEROUS_SVG_RE.test(svgText)
}

function looksLikeXmlOrSvg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return false
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase()
  return head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!--')
}

export async function validateFileSignature(filePathOrBuffer, options = {}) {
  const { expectedType, allowedTypes, filename, maxBytes } = options

  let headerBuf
  let fullBuf = null
  let fileSize = 0

  if (Buffer.isBuffer(filePathOrBuffer)) {
    fileSize = filePathOrBuffer.length
    headerBuf = filePathOrBuffer.subarray(0, Math.min(fileSize, 4096))
    fullBuf = filePathOrBuffer
  } else if (typeof filePathOrBuffer === 'string') {
    const stat = await fs.promises.lstat(filePathOrBuffer)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new FileValidationError('Uploaded file must be a regular file', {
        statusCode: 400,
        code: 'INVALID_FILE_TYPE',
      })
    }
    fileSize = stat.size
    const fd = await fs.promises.open(filePathOrBuffer, 'r')
    try {
      headerBuf = Buffer.alloc(4096)
      const { bytesRead } = await fd.read(headerBuf, 0, 4096, 0)
      headerBuf = headerBuf.subarray(0, bytesRead)
    } finally {
      await fd.close()
    }
  } else {
    throw new FileValidationError('Invalid file input: must be file path or Buffer', {
      statusCode: 400,
      code: 'VALIDATION',
    })
  }

  if (fileSize <= 0) {
    throw new FileValidationError('Uploaded file cannot be empty', {
      statusCode: 400,
      code: 'EMPTY_FILE',
    })
  }

  if (maxBytes && fileSize > maxBytes) {
    throw new FileValidationError(`File size (${fileSize} bytes) exceeds limit of ${maxBytes} bytes`, {
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      extra: { size: fileSize, maxBytes },
    })
  }

  // 1. Dangerous signature check
  const dangerous = isDangerousSignature(headerBuf)
  if (dangerous.dangerous) {
    throw new FileValidationError(`Dangerous or executable file rejected: ${dangerous.reason}`, {
      statusCode: 400,
      code: 'MALICIOUS_FILE_DETECTED',
      extra: { reason: dangerous.reason },
    })
  }

  // 2. Detect media signature (for SVG/XML, read full payload up to IMAGE limit to prevent padding bypass)
  const isSvgFilename = typeof filename === 'string' && filename.toLowerCase().trim().endsWith('.svg')
  let bufToDetect = headerBuf
  if (looksLikeXmlOrSvg(headerBuf) || isSvgFilename) {
    if (fullBuf) {
      bufToDetect = fullBuf
    } else if (typeof filePathOrBuffer === 'string' && fileSize <= FILE_SIZE_LIMITS.IMAGE) {
      bufToDetect = await fs.promises.readFile(filePathOrBuffer)
    }
  }
  const detected = detectFileSignature(bufToDetect)
  if (!detected) {
    throw new FileValidationError('File signature could not be verified or is unsupported', {
      statusCode: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
    })
  }

  if (detected.dangerous) {
    throw new FileValidationError(`Dangerous file content rejected: ${detected.reason}`, {
      statusCode: 400,
      code: 'MALICIOUS_FILE_DETECTED',
      extra: { reason: detected.reason },
    })
  }

  // 3. Allowed / expected types verification
  if (expectedType && detected.type !== expectedType) {
    throw new FileValidationError(`File type mismatch: expected ${expectedType}, detected ${detected.type} (${detected.format})`, {
      statusCode: 415,
      code: 'MEDIA_TYPE_MISMATCH',
      extra: { expected: expectedType, detected: detected.type },
    })
  }

  if (Array.isArray(allowedTypes) && !allowedTypes.includes(detected.type)) {
    throw new FileValidationError(`File type "${detected.type}" is not in the allowed types list`, {
      statusCode: 415,
      code: 'MEDIA_TYPE_NOT_ALLOWED',
      extra: { allowed: allowedTypes, detected: detected.type },
    })
  }

  // 4. Filename extension matching validation
  if (filename && typeof filename === 'string') {
    const cleanBase = path.basename(filename.replace(/[\0\r\n]/g, '').trim())
    const ext = path.extname(cleanBase).toLowerCase()
    const allowedForType = ALLOWED_EXTENSIONS_BY_TYPE[detected.type]

    if (allowedForType && !allowedForType.has(ext)) {
      throw new FileValidationError(`File extension "${ext}" does not match detected file type "${detected.type}" (${detected.format})`, {
        statusCode: 415,
        code: 'FILE_SIGNATURE_MISMATCH',
        extra: { extension: ext, detectedType: detected.type, detectedFormat: detected.format },
      })
    }
  }

  return {
    valid: true,
    type: detected.type,
    format: detected.format,
    mime: detected.mime,
    ext: detected.ext,
  }
}

/**
 * Generates an unguessable, safe UUIDv4 storage filename and sanitizes extension.
 * Eliminates path traversal (../, ..\, null bytes, control characters).
 *
 * @param {string} originalName - Client-provided original filename
 * @param {object} [options]
 * @param {string} [options.prefix=''] - Storage prefix directory (e.g. 'uploads/')
 * @param {string} [options.defaultExt=''] - Fallback extension if none provided
 * @returns {string} Safe storage key (e.g. 'uploads/550e8400-e29b-41d4-a716-446655440000.mp4')
 */
export function sanitizeStorageFilename(originalName, { prefix = '', defaultExt = '' } = {}) {
  const rawName = String(originalName || '').replace(/[\0\r\n\t]/g, '').trim()
  const base = path.basename(rawName)
  let ext = path.extname(base).toLowerCase().replace(/[^a-z0-9.]/g, '')

  if (!ext && defaultExt) {
    ext = defaultExt.startsWith('.') ? defaultExt.toLowerCase() : `.${defaultExt.toLowerCase()}`
  }

  const cleanPrefix = prefix.replace(/[\0\r\n]/g, '').replace(/^[/\\]+/, '').replace(/[/\\]+$/, '')
  const randomId = crypto.randomUUID()
  const fileName = `${randomId}${ext}`

  return cleanPrefix ? `${cleanPrefix}/${fileName}` : fileName
}

/**
 * Asserts that an upload target path is safely contained within baseDir.
 * Prevents path traversal and directory escape attempts.
 *
 * @param {string} baseDir - Base root directory
 * @param {string} targetPath - Target path to verify
 * @throws {FileValidationError} if path escapes base directory
 */
export function assertSafeUploadPath(baseDir, targetPath) {
  if (typeof baseDir !== 'string' || !baseDir.trim()) {
    throw new FileValidationError('Base storage directory is required', { statusCode: 500, code: 'INVALID_BASE_DIR' })
  }
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new FileValidationError('Target upload path is required', { statusCode: 400, code: 'INVALID_TARGET_PATH' })
  }
  if (targetPath.includes('\0') || baseDir.includes('\0')) {
    throw new FileValidationError('Null bytes not allowed in storage path', { statusCode: 400, code: 'INVALID_PATH_CHARACTERS' })
  }

  const isContained = isPathInside(baseDir, targetPath, { allowRoot: false })
  if (!isContained) {
    throw new FileValidationError('Upload path escapes storage directory boundary', {
      statusCode: 409,
      code: 'UPLOAD_PATH_UNSAFE',
    })
  }
  return true
}

/**
 * Safely unlinks a temporary file without throwing on missing file.
 *
 * @param {string} filePath - Path to file to remove
 */
export async function cleanupTempFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return
  try {
    await fs.promises.unlink(filePath)
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      // ignore or log quietly
    }
  }
}
