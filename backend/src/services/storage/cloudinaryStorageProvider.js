import { v2 as cloudinary } from 'cloudinary'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { StorageProvider } from './storageProvider.js'
import { detectResourceType } from './localStorageProvider.js'

export class CloudinaryStorageProvider extends StorageProvider {
  constructor({
    cloudName = '',
    apiKey = '',
    apiSecret = '',
    url = '',
    folderPrefix = 'video_ai',
  } = {}) {
    super('cloudinary')
    this.cloudName = cloudName
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.url = url
    this.folderPrefix = folderPrefix.replace(/^\/+|\/+$/g, '')
    this._configured = false

    this._initialize()
  }

  _initialize() {
    if (this.url) {
      cloudinary.config({
        cloudinary_url: this.url,
        secure: true,
      })
      this._configured = true
      return
    }

    if (this.cloudName && this.apiKey && this.apiSecret) {
      cloudinary.config({
        cloud_name: this.cloudName,
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        secure: true,
      })
      this._configured = true
      return
    }

    this._configured = false
  }

  isConfigured() {
    return this._configured
  }

  _buildPublicId(key, folder) {
    if (key) {
      // If caller passed full path or custom key
      const cleanKey = String(key).replace(/^\/+/, '')
      // Strip file extension for image and video types (Cloudinary appends it based on format)
      return cleanKey
    }
    const cleanFolder = folder ? `${this.folderPrefix}/${folder.replace(/^\/+/, '')}` : this.folderPrefix
    return cleanFolder
  }

  async upload(filePathOrBuffer, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('CloudinaryStorageProvider is not configured with valid credentials')
    }

    const resourceType = options.resourceType || detectResourceType(options.key || options.filename || '', options.mimeType)
    const folder = options.folder ? `${this.folderPrefix}/${options.folder.replace(/^\/+/, '')}` : this.folderPrefix
    
    // For raw files (subtitles, text), keep extension in public_id
    // For video/image, Cloudinary manages extension via format
    let publicId = options.publicId || options.key || undefined
    if (publicId && !publicId.startsWith(this.folderPrefix)) {
      publicId = `${this.folderPrefix}/${publicId.replace(/^\/+/, '')}`
    }

    const uploadOptions = {
      resource_type: resourceType,
      folder: publicId ? undefined : folder,
      public_id: publicId || undefined,
      overwrite: options.overwrite !== false,
      use_filename: Boolean(options.useFilename),
      unique_filename: options.uniqueFilename !== false,
      tags: options.tags || ['video_ai'],
    }

    if (options.transformation) {
      uploadOptions.transformation = options.transformation
    }

    let result
    if (Buffer.isBuffer(filePathOrBuffer)) {
      result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, res) => {
          if (error) return reject(error)
          resolve(res)
        })
        stream.end(filePathOrBuffer)
      })
    } else if (typeof filePathOrBuffer === 'string') {
      result = await cloudinary.uploader.upload(filePathOrBuffer, uploadOptions)
    } else {
      throw new Error('upload() expects a file path string or Buffer')
    }

    return {
      provider: 'cloudinary',
      key: result.public_id,
      publicId: result.public_id,
      assetId: result.asset_id,
      url: result.secure_url || result.url,
      secureUrl: result.secure_url,
      resourceType: result.resource_type,
      format: result.format || options.format || path.extname(options.key || '').replace(/^\./, ''),
      bytes: result.bytes,
      width: result.width || null,
      height: result.height || null,
      duration: result.duration || null,
      createdAt: result.created_at,
      meta: {
        version: result.version,
        signature: result.signature,
        etag: result.etag,
      },
      raw: result,
    }
  }

  async uploadLarge(filePath, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('CloudinaryStorageProvider is not configured with valid credentials')
    }

    const resourceType = options.resourceType || detectResourceType(options.key || filePath, options.mimeType)
    const folder = options.folder ? `${this.folderPrefix}/${options.folder.replace(/^\/+/, '')}` : this.folderPrefix

    let publicId = options.publicId || options.key || undefined
    if (publicId && !publicId.startsWith(this.folderPrefix)) {
      publicId = `${this.folderPrefix}/${publicId.replace(/^\/+/, '')}`
    }

    const uploadOptions = {
      resource_type: resourceType,
      chunk_size: options.chunkSize || 6000000, // 6MB default chunks
      folder: publicId ? undefined : folder,
      public_id: publicId || undefined,
      overwrite: options.overwrite !== false,
      tags: options.tags || ['video_ai', 'large'],
    }

    const result = await cloudinary.uploader.upload_large(filePath, uploadOptions)

    return {
      provider: 'cloudinary',
      key: result.public_id,
      publicId: result.public_id,
      assetId: result.asset_id,
      url: result.secure_url || result.url,
      secureUrl: result.secure_url,
      resourceType: result.resource_type,
      format: result.format,
      bytes: result.bytes,
      width: result.width || null,
      height: result.height || null,
      duration: result.duration || null,
      createdAt: result.created_at,
      meta: {
        version: result.version,
        signature: result.signature,
        etag: result.etag,
      },
      raw: result,
    }
  }

  async uploadStream(readableStream, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('CloudinaryStorageProvider is not configured with valid credentials')
    }

    const resourceType = options.resourceType || detectResourceType(options.key || '', options.mimeType)
    const folder = options.folder ? `${this.folderPrefix}/${options.folder.replace(/^\/+/, '')}` : this.folderPrefix

    let publicId = options.publicId || options.key || undefined
    if (publicId && !publicId.startsWith(this.folderPrefix)) {
      publicId = `${this.folderPrefix}/${publicId.replace(/^\/+/, '')}`
    }

    const uploadOptions = {
      resource_type: resourceType,
      folder: publicId ? undefined : folder,
      public_id: publicId || undefined,
      overwrite: options.overwrite !== false,
      tags: options.tags || ['video_ai', 'stream'],
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, res) => {
        if (error) return reject(error)
        resolve(res)
      })
      readableStream.pipe(stream)
      readableStream.on('error', reject)
    })

    return {
      provider: 'cloudinary',
      key: result.public_id,
      publicId: result.public_id,
      assetId: result.asset_id,
      url: result.secure_url || result.url,
      secureUrl: result.secure_url,
      resourceType: result.resource_type,
      format: result.format,
      bytes: result.bytes,
      width: result.width || null,
      height: result.height || null,
      duration: result.duration || null,
      createdAt: result.created_at,
      meta: {
        version: result.version,
        signature: result.signature,
      },
      raw: result,
    }
  }

  getUrl(keyOrPublicId, options = {}) {
    if (!keyOrPublicId) return null
    if (/^https?:\/\//i.test(keyOrPublicId)) return keyOrPublicId

    const resourceType = options.resourceType || detectResourceType(keyOrPublicId)
    return cloudinary.url(keyOrPublicId, {
      secure: true,
      resource_type: resourceType,
      transformation: options.transformation,
    })
  }

  async getAsset(keyOrPublicId, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('CloudinaryStorageProvider is not configured')
    }

    const resourceType = options.resourceType || detectResourceType(keyOrPublicId)
    const result = await cloudinary.api.resource(keyOrPublicId, {
      resource_type: resourceType,
    })

    return {
      provider: 'cloudinary',
      key: result.public_id,
      publicId: result.public_id,
      assetId: result.asset_id,
      url: result.secure_url || result.url,
      secureUrl: result.secure_url,
      resourceType: result.resource_type,
      format: result.format,
      bytes: result.bytes,
      width: result.width || null,
      height: result.height || null,
      duration: result.duration || null,
      createdAt: result.created_at,
      meta: {
        version: result.version,
      },
      raw: result,
    }
  }

  async delete(keyOrPublicId, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('CloudinaryStorageProvider is not configured')
    }

    const resourceType = options.resourceType || detectResourceType(keyOrPublicId)
    const result = await cloudinary.uploader.destroy(keyOrPublicId, {
      resource_type: resourceType,
      invalidate: options.invalidate !== false,
    })

    const success = result?.result === 'ok'
    return {
      success,
      key: keyOrPublicId,
      result: result?.result,
      raw: result,
    }
  }

  async downloadToTemp(keyOrUrl, destinationPath) {
    const dest = path.resolve(destinationPath)
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })

    const targetUrl = /^https?:\/\//i.test(keyOrUrl) ? keyOrUrl : this.getUrl(keyOrUrl)
    if (!targetUrl) throw new Error(`Could not resolve download URL for: ${keyOrUrl}`)

    const client = targetUrl.startsWith('https') ? https : http

    return new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(dest)
      const req = client.get(targetUrl, (res) => {
        // Handle redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fileStream.close()
          return this.downloadToTemp(res.headers.location, destinationPath).then(resolve).catch(reject)
        }

        if (res.statusCode !== 200) {
          fileStream.close()
          fs.unlink(dest, () => {})
          return reject(new Error(`Failed to download asset: HTTP ${res.statusCode}`))
        }

        let downloadedBytes = 0
        res.on('data', (chunk) => {
          downloadedBytes += chunk.length
        })
        res.pipe(fileStream)

        fileStream.on('finish', () => {
          fileStream.close(() => {
            resolve({ destinationPath: dest, bytes: downloadedBytes })
          })
        })
      })

      req.on('error', (err) => {
        fileStream.close()
        fs.unlink(dest, () => {})
        reject(err)
      })
    })
  }

  async exists(keyOrPublicId, options = {}) {
    if (!this.isConfigured()) return false
    try {
      await this.getAsset(keyOrPublicId, options)
      return true
    } catch (err) {
      if (err?.error?.http_code === 404 || err?.http_code === 404) return false
      throw err
    }
  }
}
