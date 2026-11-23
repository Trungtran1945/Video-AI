/**
 * Base abstract contract for Video_AI storage providers.
 */
export class StorageProvider {
  constructor(name) {
    if (!name) throw new Error('StorageProvider requires a provider name')
    this.name = name
  }

  isConfigured() {
    return true
  }

  async upload(_filePathOrBuffer, _options = {}) {
    throw new Error(`${this.name}: upload() not implemented`)
  }

  async uploadLarge(_filePath, _options = {}) {
    throw new Error(`${this.name}: uploadLarge() not implemented`)
  }

  async uploadStream(_readableStream, _options = {}) {
    throw new Error(`${this.name}: uploadStream() not implemented`)
  }

  getUrl(_keyOrPublicId, _options = {}) {
    throw new Error(`${this.name}: getUrl() not implemented`)
  }

  async getAsset(_keyOrPublicId, _options = {}) {
    throw new Error(`${this.name}: getAsset() not implemented`)
  }

  async delete(_keyOrPublicId, _options = {}) {
    throw new Error(`${this.name}: delete() not implemented`)
  }

  async downloadToTemp(_keyOrUrl, _destinationPath) {
    throw new Error(`${this.name}: downloadToTemp() not implemented`)
  }

  async exists(_keyOrPublicId, _options = {}) {
    throw new Error(`${this.name}: exists() not implemented`)
  }
}
