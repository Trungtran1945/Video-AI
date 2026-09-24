import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let mediaValidation = null
try {
  mediaValidation = await import('../src/services/mediaValidation.js')
} catch (_) {}

let failures = 0
function assert(condition, message) {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

assert(Boolean(mediaValidation), 'media validation service is available')
if (!mediaValidation) process.exit(1)

const { validateVideoMetadata, canonicalVideoMimeType, assertVideoFile } = mediaValidation
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-media-policy-'))
const isoMp4 = Buffer.alloc(16)
isoMp4.writeUInt32BE(24, 0)
isoMp4.write('ftyp', 4, 'ascii')
isoMp4.write('isom', 8, 'ascii')
const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04])

const mp4Path = path.join(tmpRoot, 'sample.mp4')
fs.writeFileSync(mp4Path, isoMp4)
const mkvPath = path.join(tmpRoot, 'sample.mkv')
fs.writeFileSync(mkvPath, ebml)
const htmlPath = path.join(tmpRoot, 'spoofed.mp4')
fs.writeFileSync(htmlPath, '<html><script>alert(1)</script></html>')

assert(validateVideoMetadata({ filename: 'movie.mp4', mime: 'video/mp4' }).extension === '.mp4', 'MP4 metadata is accepted')
assert(validateVideoMetadata({ filename: 'movie.mkv', mime: 'video/x-matroska' }).extension === '.mkv', 'Matroska metadata is accepted')
assert(canonicalVideoMimeType('.m4v') === 'video/x-m4v', 'M4V response MIME is canonical')
assert(canonicalVideoMimeType('.mov') === 'video/quicktime', 'MOV response MIME is canonical')
assert(canonicalVideoMimeType('.webm') === 'video/webm', 'WebM response MIME is canonical')

for (const input of [
  { filename: 'active.html', mime: 'text/html' },
  { filename: 'active.svg', mime: 'image/svg+xml' },
  { filename: 'movie.avi', mime: 'video/x-msvideo' },
  { filename: 'movie.mp4', mime: 'image/png' },
  { filename: '../movie.mp4', mime: 'video/mp4' },
  { filename: 'movie.mp4', mime: '' },
]) {
  let rejected = false
  try { validateVideoMetadata(input) } catch (_) { rejected = true }
  assert(rejected, `unsafe metadata is rejected: ${JSON.stringify(input)}`)
}

let acceptedSignature = false
try {
  await assertVideoFile(mp4Path, '.mp4')
  acceptedSignature = true
} catch (_) {}
assert(acceptedSignature, 'ISO-BMFF signature is accepted')

let acceptedMatroska = false
try {
  await assertVideoFile(mkvPath, '.mkv', { probe: null })
  acceptedMatroska = true
} catch (_) {}
assert(acceptedMatroska, 'EBML signature is accepted without ffprobe')

let rejectedSpoof = false
try { await assertVideoFile(htmlPath, '.mp4', { probe: null }) } catch (_) { rejectedSpoof = true }
assert(rejectedSpoof, 'HTML bytes with a video extension are rejected')

let rejectedNoVideoStream = false
try {
  await assertVideoFile(mp4Path, '.mp4', { probe: async () => ({ codec: null }) })
} catch (_) { rejectedNoVideoStream = true }
assert(rejectedNoVideoStream, 'ffprobe metadata without a video stream is rejected')

let acceptedVideoStream = false
try {
  await assertVideoFile(mp4Path, '.mp4', { probe: async () => ({ codec: 'h264' }) })
  acceptedVideoStream = true
} catch (_) {}
assert(acceptedVideoStream, 'ffprobe video metadata is accepted')

let probeFailureClassified = false
try {
  await assertVideoFile(mp4Path, '.mp4', { probe: async () => { throw new Error('probe failed') } })
} catch (error) {
  probeFailureClassified = error?.code === 'UNSUPPORTED_MEDIA_TYPE'
}
assert(probeFailureClassified, 'ffprobe failures are classified as unsupported media')

fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
