import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveStorageUrl,
  appendCacheBuster,
  isCloudinaryUrl,
  getMediaDownloadUrl,
  getMediaThumbnailUrl,
  isMediaVideo,
  isMediaAudio,
} from './apiBase.js'

test('resolveStorageUrl returns null for empty or invalid values', () => {
  assert.equal(resolveStorageUrl(null), null)
  assert.equal(resolveStorageUrl(undefined), null)
  assert.equal(resolveStorageUrl(''), null)
  assert.equal(resolveStorageUrl('   '), null)
})

test('resolveStorageUrl preserves absolute URLs (Cloudinary, HTTPS, HTTP)', () => {
  const cldUrl = 'https://res.cloudinary.com/demo/video/upload/v123456/sample.mp4'
  assert.equal(resolveStorageUrl(cldUrl), cldUrl)

  const httpUrl = 'http://example.com/media/test.mp3'
  assert.equal(resolveStorageUrl(httpUrl), httpUrl)

  const blobUrl = 'blob:http://localhost:5173/uuid-123'
  assert.equal(resolveStorageUrl(blobUrl), blobUrl)

  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
  assert.equal(resolveStorageUrl(dataUrl), dataUrl)
})

test('resolveStorageUrl resolves relative storage keys correctly', () => {
  assert.equal(resolveStorageUrl('outputs/video.mp4'), '/storage/outputs/video.mp4')
  assert.equal(resolveStorageUrl('storage/outputs/video.mp4'), '/storage/outputs/video.mp4')
  assert.equal(resolveStorageUrl('/storage/outputs/video.mp4'), '/storage/outputs/video.mp4')
})

test('resolveStorageUrl extracts URL from object with secure_url or storage_key', () => {
  const cldObj = { secure_url: 'https://res.cloudinary.com/demo/video/upload/v1/test.mp4' }
  assert.equal(resolveStorageUrl(cldObj), 'https://res.cloudinary.com/demo/video/upload/v1/test.mp4')

  const localObj = { storage_key: 'uploads/file.mp4' }
  assert.equal(resolveStorageUrl(localObj), '/storage/uploads/file.mp4')

  const altObj = { url: 'https://res.cloudinary.com/demo/image/upload/v1/img.jpg' }
  assert.equal(resolveStorageUrl(altObj), 'https://res.cloudinary.com/demo/image/upload/v1/img.jpg')
})

test('appendCacheBuster correctly adds query parameter', () => {
  assert.equal(appendCacheBuster('https://res.cloudinary.com/test.mp4', '123'), 'https://res.cloudinary.com/test.mp4?v=123')
  assert.equal(appendCacheBuster('https://res.cloudinary.com/test.mp4?foo=bar', '123'), 'https://res.cloudinary.com/test.mp4?foo=bar&v=123')
  assert.equal(appendCacheBuster('https://res.cloudinary.com/test.mp4', null), 'https://res.cloudinary.com/test.mp4')
  assert.equal(appendCacheBuster(null, '123'), null)
})

test('isCloudinaryUrl identifies Cloudinary domain', () => {
  assert.equal(isCloudinaryUrl('https://res.cloudinary.com/demo/video/upload/v1/a.mp4'), true)
  assert.equal(isCloudinaryUrl('/storage/outputs/video.mp4'), false)
  assert.equal(isCloudinaryUrl('https://s3.amazonaws.com/bucket/file.mp4'), false)
})

test('getMediaDownloadUrl adds fl_attachment to Cloudinary URLs', () => {
  const cld = 'https://res.cloudinary.com/demo/video/upload/v1234/sample.mp4'
  const dl = getMediaDownloadUrl(cld, 'my-video.mp4')
  assert.ok(dl.includes('/upload/fl_attachment:my-video/'), `Expected fl_attachment:my-video in ${dl}`)

  // Should not double-add if already present
  assert.equal(getMediaDownloadUrl(dl, 'my-video.mp4'), dl)

  // Local storage returns as-is
  const local = '/storage/outputs/video.mp4'
  assert.equal(getMediaDownloadUrl(local, 'video.mp4'), local)
})

test('getMediaThumbnailUrl produces poster snapshots from Cloudinary video URLs', () => {
  const cldVideo = 'https://res.cloudinary.com/demo/video/upload/v1234/sample.mp4'
  const thumb = getMediaThumbnailUrl(cldVideo)
  assert.equal(thumb, 'https://res.cloudinary.com/demo/video/upload/v1234/sample.jpg')

  const assetObj = { thumbnail_url: 'https://res.cloudinary.com/demo/image/upload/v1/thumb.jpg' }
  assert.equal(getMediaThumbnailUrl(assetObj), 'https://res.cloudinary.com/demo/image/upload/v1/thumb.jpg')
})

test('isMediaVideo detects videos across formats and properties', () => {
  assert.equal(isMediaVideo('test.mp4'), true)
  assert.equal(isMediaVideo('https://res.cloudinary.com/video.webm'), true)
  assert.equal(isMediaVideo({ resource_type: 'video' }), true)
  assert.equal(isMediaVideo({ format: 'mp4' }), true)
  assert.equal(isMediaVideo({ mimeType: 'video/mp4' }), true)
  assert.equal(isMediaVideo({ kind: 'video' }), true)
  assert.equal(isMediaVideo({ secure_url: 'https://res.cloudinary.com/demo/upload/v1/clip.mov' }), true)
  assert.equal(isMediaVideo('audio.mp3'), false)
  assert.equal(isMediaVideo({ resource_type: 'image' }), false)
})

test('isMediaAudio detects audio across formats and properties', () => {
  assert.equal(isMediaAudio('speech.mp3'), true)
  assert.equal(isMediaAudio('sound.wav'), true)
  assert.equal(isMediaAudio({ resource_type: 'audio' }), true)
  assert.equal(isMediaAudio({ format: 'mp3' }), true)
  assert.equal(isMediaAudio({ mimeType: 'audio/mpeg' }), true)
  assert.equal(isMediaAudio({ kind: 'voiceover' }), true)
  assert.equal(isMediaAudio({ kind: 'bgm' }), true)
  assert.equal(isMediaAudio('movie.mp4'), false)
})
