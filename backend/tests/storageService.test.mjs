import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import {
  StorageService,
  LocalStorageProvider,
  CloudinaryStorageProvider,
  detectResourceType,
} from '../src/services/storage/index.js'
import { UnsafeStoragePathError } from '../src/lib/safePath.js'

describe('Storage Service & Providers', () => {
  let tmpStorageDir

  before(async () => {
    tmpStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-ai-storage-test-'))
  })

  after(async () => {
    if (tmpStorageDir && fs.existsSync(tmpStorageDir)) {
      fs.rmSync(tmpStorageDir, { recursive: true, force: true })
    }
  })

  describe('detectResourceType', () => {
    it('detects images by extension and mime', () => {
      assert.equal(detectResourceType('photo.jpg'), 'image')
      assert.equal(detectResourceType('pic.png'), 'image')
      assert.equal(detectResourceType('banner.webp'), 'image')
      assert.equal(detectResourceType('file.dat', 'image/jpeg'), 'image')
    })

    it('detects videos and audios by extension and mime', () => {
      assert.equal(detectResourceType('video.mp4'), 'video')
      assert.equal(detectResourceType('clip.webm'), 'video')
      assert.equal(detectResourceType('voice.mp3'), 'video') // Cloudinary treats audio as video
      assert.equal(detectResourceType('track.wav'), 'video')
      assert.equal(detectResourceType('unknown', 'video/mp4'), 'video')
      assert.equal(detectResourceType('unknown', 'audio/wav'), 'video')
    })

    it('detects raw assets by extension (subtitles, text, json, doc)', () => {
      assert.equal(detectResourceType('subtitles.srt'), 'raw')
      assert.equal(detectResourceType('subtitles.ass'), 'raw')
      assert.equal(detectResourceType('script.txt'), 'raw')
      assert.equal(detectResourceType('data.json'), 'raw')
    })
  })

  describe('LocalStorageProvider', () => {
    let localProvider

    before(() => {
      localProvider = new LocalStorageProvider({ storageDir: tmpStorageDir })
    })

    it('reports configured as true', () => {
      assert.equal(localProvider.isConfigured(), true)
    })

    it('uploads a buffer successfully', async () => {
      const buf = Buffer.from('test media content')
      const result = await localProvider.upload(buf, {
        key: 'uploads/test-buffer.mp4',
        mimeType: 'video/mp4',
      })

      assert.equal(result.provider, 'local')
      assert.equal(result.key, 'uploads/test-buffer.mp4')
      assert.equal(result.url, '/storage/uploads/test-buffer.mp4')
      assert.equal(result.resourceType, 'video')
      assert.equal(result.format, 'mp4')
      assert.equal(result.bytes, buf.length)

      const onDisk = path.join(tmpStorageDir, 'uploads', 'test-buffer.mp4')
      assert.equal(fs.existsSync(onDisk), true)
      assert.equal(fs.readFileSync(onDisk, 'utf8'), 'test media content')
    })

    it('uploads from a file path', async () => {
      const srcFile = path.join(tmpStorageDir, 'temp-source.jpg')
      fs.writeFileSync(srcFile, 'image binary data')

      const result = await localProvider.upload(srcFile, {
        key: 'projects/proj-1/thumb.jpg',
        mimeType: 'image/jpeg',
      })

      assert.equal(result.provider, 'local')
      assert.equal(result.key, 'projects/proj-1/thumb.jpg')
      assert.equal(result.resourceType, 'image')
      assert.equal(result.format, 'jpg')
      assert.equal(result.bytes, 17)
    })

    it('uploads from a stream', async () => {
      const stream = Readable.from(['stream ', 'chunk ', 'data'])
      const result = await localProvider.uploadStream(stream, {
        key: 'outputs/stream-test.mp4',
        mimeType: 'video/mp4',
      })

      assert.equal(result.provider, 'local')
      assert.equal(result.key, 'outputs/stream-test.mp4')
      assert.equal(result.bytes, 17)
    })

    it('checks asset existence and gets asset details', async () => {
      const exists = await localProvider.exists('uploads/test-buffer.mp4')
      assert.equal(exists, true)

      const notExists = await localProvider.exists('uploads/non-existent.mp4')
      assert.equal(notExists, false)

      const asset = await localProvider.getAsset('uploads/test-buffer.mp4')
      assert.equal(asset.key, 'uploads/test-buffer.mp4')
      assert.equal(asset.format, 'mp4')
      assert.equal(asset.bytes, 18)
    })

    it('downloads to temp destination path', async () => {
      const destPath = path.join(tmpStorageDir, 'temp-downloaded', 'copy.mp4')
      const result = await localProvider.downloadToTemp('uploads/test-buffer.mp4', destPath)

      assert.equal(result.destinationPath, destPath)
      assert.equal(result.bytes, 18)
      assert.equal(fs.existsSync(destPath), true)
    })

    it('deletes an asset cleanly', async () => {
      const delResult = await localProvider.delete('uploads/test-buffer.mp4')
      assert.equal(delResult.success, true)
      assert.equal(await localProvider.exists('uploads/test-buffer.mp4'), false)
    })

    it('rejects path traversal keys', async () => {
      await assert.rejects(
        async () => localProvider.upload(Buffer.from('bad'), { key: '../escape.txt' }),
        UnsafeStoragePathError
      )
    })
  })

  describe('CloudinaryStorageProvider', () => {
    it('reports not configured when credentials missing', () => {
      const unconfigured = new CloudinaryStorageProvider({})
      assert.equal(unconfigured.isConfigured(), false)
    })

    it('reports configured when credentials provided', () => {
      const configured = new CloudinaryStorageProvider({
        cloudName: 'demo',
        apiKey: '123456789012345',
        apiSecret: 'abcdefghijklmnopqrstuvwxy12',
      })
      assert.equal(configured.isConfigured(), true)
    })

    it('throws error when upload is attempted without configuration', async () => {
      const unconfigured = new CloudinaryStorageProvider({})
      await assert.rejects(
        async () => unconfigured.upload(Buffer.from('test')),
        /not configured/
      )
    })

    it('generates secure cloudinary URL', () => {
      const provider = new CloudinaryStorageProvider({
        cloudName: 'demo-cloud',
        apiKey: '123456789',
        apiSecret: 'secret12345',
      })
      const url = provider.getUrl('video_ai/outputs/sample_video', { resourceType: 'video' })
      assert.match(url, /^https:\/\/res\.cloudinary\.com\/demo-cloud\/video\/upload\/(v\d+\/)?video_ai\/outputs\/sample_video/)
    })
  })

  describe('StorageService Facade', () => {
    it('falls back to local when cloudinary credentials are missing', () => {
      const service = new StorageService({
        storageDir: tmpStorageDir,
        storage: {
          provider: 'cloudinary',
          cloudinary: { cloudName: '', apiKey: '', apiSecret: '' },
          localDir: tmpStorageDir,
        },
      })

      assert.equal(service.getActiveProviderName(), 'local')
      assert.equal(service.configuredProviderName, 'cloudinary')
    })

    it('delegates upload and retrieval to active provider', async () => {
      const service = new StorageService({
        storageDir: tmpStorageDir,
        storage: {
          provider: 'local',
          localDir: tmpStorageDir,
        },
      })

      const res = await service.upload(Buffer.from('facade test'), {
        key: 'uploads/facade.txt',
      })

      assert.equal(res.provider, 'local')
      assert.equal(res.key, 'uploads/facade.txt')
      assert.equal(service.getUrl('uploads/facade.txt'), '/storage/uploads/facade.txt')
      assert.equal(await service.exists('uploads/facade.txt'), true)

      await service.delete('uploads/facade.txt')
      assert.equal(await service.exists('uploads/facade.txt'), false)
    })

    it('resolveMediaUrl returns absolute URLs unchanged', () => {
      const service = new StorageService({ storageDir: tmpStorageDir })
      const httpUrl = 'https://res.cloudinary.com/demo/video/upload/sample.mp4'
      assert.equal(service.resolveMediaUrl(httpUrl), httpUrl)
    })
  })
})
