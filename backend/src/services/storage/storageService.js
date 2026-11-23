import { LocalStorageProvider, detectResourceType } from './localStorageProvider.js'
import { CloudinaryStorageProvider } from './cloudinaryStorageProvider.js'
import { config } from '../../config.js'

export class StorageService {
  constructor(options = {}) {
    const storageConfig = options.storage || config.storage || {}
    this.configuredProviderName = storageConfig.provider || 'local'
    this.storageDir = options.storageDir || storageConfig.localDir || config.storageDir

    this.localProvider = new LocalStorageProvider({
      storageDir: this.storageDir,
    })

    this.cloudinaryProvider = new CloudinaryStorageProvider({
      cloudName: storageConfig.cloudinary?.cloudName,
      apiKey: storageConfig.cloudinary?.apiKey,
      apiSecret: storageConfig.cloudinary?.apiSecret,
      url: storageConfig.cloudinary?.url,
      folderPrefix: storageConfig.cloudinary?.folderPrefix || 'video_ai',
    })

    if (this.configuredProviderName === 'cloudinary' && !this.cloudinaryProvider.isConfigured()) {
      console.warn(
        '[StorageService] Cloudinary configured as primary provider, but credentials are missing. Falling back to local storage.'
      )
      this.activeProviderName = 'local'
    } else {
      this.activeProviderName = this.configuredProviderName
    }
  }

  getActiveProviderName() {
    return this.activeProviderName
  }

  getActiveProvider() {
    return this.activeProviderName === 'cloudinary' ? this.cloudinaryProvider : this.localProvider
  }

  getProvider(name) {
    if (name === 'cloudinary') return this.cloudinaryProvider
    if (name === 'local') return this.localProvider
    return this.getActiveProvider()
  }

  async upload(filePathOrBuffer, options = {}) {
    const provider = options.provider ? this.getProvider(options.provider) : this.getActiveProvider()
    return provider.upload(filePathOrBuffer, options)
  }

  async uploadLarge(filePath, options = {}) {
    const provider = options.provider ? this.getProvider(options.provider) : this.getActiveProvider()
    return provider.uploadLarge(filePath, options)
  }

  async uploadStream(readableStream, options = {}) {
    const provider = options.provider ? this.getProvider(options.provider) : this.getActiveProvider()
    return provider.uploadStream(readableStream, options)
  }

  getUrl(keyOrPublicId, options = {}) {
    if (!keyOrPublicId) return null
    if (/^https?:\/\//i.test(keyOrPublicId)) return keyOrPublicId

    const provider = options.provider ? this.getProvider(options.provider) : this.getActiveProvider()
    return provider.getUrl(keyOrPublicId, options)
  }

  async getAsset(keyOrPublicId, options = {}) {
    const provider = options.provider ? this.getProvider(options.provider) : this.getActiveProvider()
    return provider.getAsset(keyOrPublicId, options)
  }

  async delete(keyOrPublicId, options = {}) {
    const provider = options.provider ? this.getProvider(options.provider) : this.getActiveProvider()
    return provider.delete(keyOrPublicId, options)
  }

  async downloadToTemp(keyOrUrl, destinationPath, options = {}) {
    // If it's a URL or if provider is Cloudinary, use cloudinaryProvider or localProvider based on key pattern
    if (/^https?:\/\//i.test(keyOrUrl)) {
      return this.cloudinaryProvider.downloadToTemp(keyOrUrl, destinationPath)
    }

    const provider = options.provider ? this.getProvider(options.provider) : this.getActiveProvider()
    return provider.downloadToTemp(keyOrUrl, destinationPath)
  }

  async exists(keyOrPublicId, options = {}) {
    const provider = options.provider ? this.getProvider(options.provider) : this.getActiveProvider()
    return provider.exists(keyOrPublicId, options)
  }

  detectResourceType(filenameOrKey, mimeType) {
    return detectResourceType(filenameOrKey, mimeType)
  }

  resolveMediaUrl(keyOrUrl, options = {}) {
    return this.getUrl(keyOrUrl, options)
  }
}

export const storageService = new StorageService()
export default storageService
