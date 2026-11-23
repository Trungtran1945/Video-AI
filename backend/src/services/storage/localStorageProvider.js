import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { StorageProvider } from './storageProvider.js'
import { resolveSafePath, UnsafeStoragePathError } from '../../lib/safePath.js'

export function detectResourceType(filenameOrKey = '', mimeType = '') {
  const mime = String(mimeType || '').toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'video' // Cloudinary classifies audio as video resource_type

  const ext = path.extname(String(filenameOrKey)).toLowerCase().replace(/^\./, '')
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg'].includes(ext)) return 'image'
  if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a'].includes(ext)) return 'video'
  if (['srt', 'ass', 'vtt', 'txt', 'json', 'pdf', 'docx'].includes(ext)) return 'raw'

  return 'raw'
}

export class LocalStorageProvider extends StorageProvider {
  constructor({ storageDir }) {
    super('local')
    if (!storageDir) throw new Error('LocalStorageProvider requires storageDir')
    this.storageDir = path.resolve(storageDir)
  }

  isConfigured() {
    return true
  }

  _resolveKey(key) {
    if (!key) throw new Error('Storage key is required')
    const safePath = resolveSafePath(this.storageDir, key)
    if (!safePath) {
      throw new UnsafeStoragePathError(`Unsafe storage path for key: ${key}`)
    }
    return safePath
  }

  async upload(filePathOrBuffer, options = {}) {
    const ext = options.format
      ? `.${options.format.replace(/^\./, '')}`
      : (typeof filePathOrBuffer === 'string' ? path.extname(filePathOrBuffer) : '')
    const key = options.key || (options.folder ? `${options.folder}/${uuidv4()}${ext}` : `uploads/${uuidv4()}${ext}`)
    const absPath = this._resolveKey(key)

    await fs.promises.mkdir(path.dirname(absPath), { recursive: true })

    let byteSize = 0
    if (Buffer.isBuffer(filePathOrBuffer)) {
      await fs.promises.writeFile(absPath, filePathOrBuffer)
      byteSize = filePathOrBuffer.length
    } else if (typeof filePathOrBuffer === 'string') {
      const srcPath = path.resolve(filePathOrBuffer)
      if (srcPath !== absPath) {
        await fs.promises.copyFile(srcPath, absPath)
      }
      const stat = await fs.promises.stat(absPath)
      byteSize = stat.size
    } else {
      throw new Error('upload() expects a file path string or Buffer')
    }

    const format = path.extname(absPath).replace(/^\./, '').toLowerCase()
    const resourceType = options.resourceType || detectResourceType(absPath, options.mimeType)

    return {
      provider: 'local',
      key,
      publicId: key,
      assetId: null,
      url: `/storage/${key}`,
      secureUrl: `/storage/${key}`,
      resourceType,
      format,
      bytes: byteSize,
      meta: {
        localPath: absPath,
      },
      raw: null,
    }
  }

  async uploadLarge(filePath, options = {}) {
    return this.upload(filePath, options)
  }

  async uploadStream(readableStream, options = {}) {
    const ext = options.format ? `.${options.format.replace(/^\./, '')}` : ''
    const key = options.key || (options.folder ? `${options.folder}/${uuidv4()}${ext}` : `uploads/${uuidv4()}${ext}`)
    const absPath = this._resolveKey(key)

    await fs.promises.mkdir(path.dirname(absPath), { recursive: true })

    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(absPath)
      readableStream.pipe(writeStream)
      writeStream.on('finish', resolve)
      writeStream.on('error', reject)
      readableStream.on('error', reject)
    })

    const stat = await fs.promises.stat(absPath)
    const format = path.extname(absPath).replace(/^\./, '').toLowerCase()
    const resourceType = options.resourceType || detectResourceType(absPath, options.mimeType)

    return {
      provider: 'local',
      key,
      publicId: key,
      assetId: null,
      url: `/storage/${key}`,
      secureUrl: `/storage/${key}`,
      resourceType,
      format,
      bytes: stat.size,
      meta: { localPath: absPath },
      raw: null,
    }
  }

  getUrl(keyOrPublicId, _options = {}) {
    if (!keyOrPublicId) return null
    if (/^https?:\/\//i.test(keyOrPublicId)) return keyOrPublicId
    const cleanKey = String(keyOrPublicId).replace(/^\/+/, '')
    return cleanKey.startsWith('storage/') ? `/${cleanKey}` : `/storage/${cleanKey}`
  }

  async getAsset(keyOrPublicId, _options = {}) {
    const abs = this._resolveKey(keyOrPublicId)
    const stat = await fs.promises.stat(abs)
    const format = path.extname(abs).replace(/^\./, '').toLowerCase()
    return {
      provider: 'local',
      key: keyOrPublicId,
      publicId: keyOrPublicId,
      assetId: null,
      url: this.getUrl(keyOrPublicId),
      secureUrl: this.getUrl(keyOrPublicId),
      resourceType: detectResourceType(abs),
      format,
      bytes: stat.size,
      createdAt: stat.birthtime,
      updatedAt: stat.mtime,
      meta: { localPath: abs },
    }
  }

  async delete(keyOrPublicId, _options = {}) {
    try {
      const abs = this._resolveKey(keyOrPublicId)
      if (fs.existsSync(abs)) {
        await fs.promises.unlink(abs)
        return { success: true, key: keyOrPublicId }
      }
      return { success: false, key: keyOrPublicId, reason: 'NOT_FOUND' }
    } catch (err) {
      return { success: false, key: keyOrPublicId, error: err.message }
    }
  }

  async downloadToTemp(keyOrUrl, destinationPath) {
    const dest = path.resolve(destinationPath)
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })

    const abs = this._resolveKey(keyOrUrl)
    if (!fs.existsSync(abs)) {
      throw new Error(`Local file not found for key: ${keyOrUrl}`)
    }

    if (abs !== dest) {
      await fs.promises.copyFile(abs, dest)
    }

    const stat = await fs.promises.stat(dest)
    return {
      destinationPath: dest,
      bytes: stat.size,
    }
  }

  async exists(keyOrPublicId, _options = {}) {
    try {
      const abs = this._resolveKey(keyOrPublicId)
      return fs.existsSync(abs)
    } catch {
      return false
    }
  }
}
