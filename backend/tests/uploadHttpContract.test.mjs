import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { once } from 'node:events'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-upload-http-'))
process.env.DB_PATH = path.join(tmpRoot, 'data.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const db = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
let uploadModule = null
try {
  uploadModule = await import('../src/routes/v1/upload.js')
} catch (_) {}

await initSchema()

let failures = 0
function assert(condition, message) {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}
function mp4Bytes(size = 64) {
  const data = Buffer.alloc(size)
  data.writeUInt32BE(24, 0)
  data.write('ftyp', 4, 'ascii')
  data.write('isom', 8, 'ascii')
  data.write('http-payload', 12, 'ascii')
  return data
}
async function jsonBody(response) {
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

assert(Boolean(uploadModule?.createUploadRouter), 'upload router factory is available')
if (!uploadModule?.createUploadRouter) process.exit(1)

const { createUploadRouter } = uploadModule
const { createResumableUploadService } = await import('../src/services/resumableUploadService.js')
const service = createResumableUploadService({ storageDir: process.env.STORAGE_DIR, db, probe: null })
const router = createUploadRouter({ service, mediaProbe: null })
const app = express()
app.use(express.json({ limit: '1mb' }))
app.use('/api/v1/uploads', router)
app.use('/api/v1/upload', router)
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error)
  const status = Number(error?.status || error?.statusCode || 500)
  return res.status(status).json({
    message: error?.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the upload limit' : 'Upload request failed',
    code: error?.code === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'UPLOAD_PARSER_ERROR',
    error: {
      code: error?.code === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'UPLOAD_PARSER_ERROR',
      message: error?.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the upload limit' : 'Upload request failed',
    },
  })
})
const server = app.listen(0)
await once(server, 'listening')
const address = server.address()
const origin = `http://127.0.0.1:${address.port}`
const user = { id: 'upload-http-user', email: 'upload-http@test.local', role: 'user', password: 'test' }
await db.insert('users', user)
const token = generateAccessToken(user)
const authHeaders = (extra = {}) => ({ authorization: `Bearer ${token}`, ...extra })

const init = (payload) => fetch(`${origin}/api/v1/uploads/init`, {
  method: 'POST',
  headers: authHeaders({ 'content-type': 'application/json' }),
  body: JSON.stringify(payload),
})

const unauthenticated = await fetch(`${origin}/api/v1/uploads/init`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ filename: 'movie.mp4', size: 64, mime: 'video/mp4' }),
})
assert(unauthenticated.status === 401, 'upload init requires authentication')

for (const invalid of [-1, 0, 1.5, 'NaN', 'Infinity', null]) {
  const response = await init({ filename: 'invalid.mp4', size: invalid, mime: 'video/mp4' })
  assert(response.status === 400, `invalid declared size is rejected: ${String(invalid)}`)
}
const tooLarge = await init({ filename: 'large.mp4', size: 2 * 1024 * 1024 * 1024 + 1, mime: 'video/mp4' })
assert(tooLarge.status === 413, 'declared resumable size above 2GiB is rejected')
const missingFilename = await init({ size: 64, mime: 'video/mp4' })
assert(missingFilename.status === 400, 'filename is required')
const activeHtml = await init({ filename: 'attack.html', size: 64, mime: 'text/html' })
assert(activeHtml.status === 415, 'active-content extension is rejected')
const wrongMime = await init({ filename: 'movie.mp4', size: 64, mime: 'image/png' })
assert(wrongMime.status === 415, 'non-video client MIME is rejected')

const initial = await init({ filename: 'race.mp4', size: 8, mime: 'video/mp4' })
const initialBody = await initial.json()
assert(initial.status === 201 && initialBody.chunkSize === 8 * 1024 * 1024, 'valid init preserves the 8MiB protocol')
const head = await fetch(`${origin}/api/v1/uploads/${initialBody.uploadId}`, { method: 'HEAD', headers: authHeaders() })
assert(head.status === 200 && head.headers.get('upload-offset') === '0', 'HEAD starts at committed offset zero')

const duplicateChunk = Buffer.from('12345678')
const putChunk = (uploadId, offset, chunk) => fetch(`${origin}/api/v1/uploads/${uploadId}/chunk?offset=${offset}`, {
  method: 'PUT',
  headers: authHeaders({ 'content-type': 'application/octet-stream' }),
  body: chunk,
})
const concurrentChunks = await Promise.all(Array.from({ length: 100 }, () => putChunk(initialBody.uploadId, 0, duplicateChunk)))
const chunkStatuses = concurrentChunks.map((response) => response.status)
assert(chunkStatuses.filter((status) => status === 204).length === 1, '100 concurrent HTTP chunks accept exactly once')
assert(chunkStatuses.filter((status) => status === 409).length === 99, 'duplicate HTTP offsets return 409')
const raceBlob = path.join(process.env.STORAGE_DIR, 'tmp', 'upload_sessions', initialBody.uploadId, 'blob')
assert(fs.readFileSync(raceBlob).equals(duplicateChunk), 'concurrent HTTP chunks do not duplicate bytes')

const limitInit = await init({ filename: 'limits.mp4', size: 16 * 1024 * 1024, mime: 'video/mp4' })
const limitBody = await limitInit.json()
const tooLargeChunk = await putChunk(limitBody.uploadId, 0, Buffer.alloc(8 * 1024 * 1024 + 1))
const tooLargeBody = await tooLargeChunk.json()
assert(tooLargeChunk.status === 413 && tooLargeBody.error.code === 'CHUNK_TOO_LARGE', 'chunk above 8MiB returns 413')
const remainingInit = await init({ filename: 'remaining.mp4', size: 4, mime: 'video/mp4' })
const remainingBody = await remainingInit.json()
const overRemaining = await putChunk(remainingBody.uploadId, 0, Buffer.alloc(5))
const overRemainingBody = await overRemaining.json()
assert(overRemaining.status === 413 && overRemainingBody.error.code === 'CHUNK_EXCEEDS_REMAINING_SIZE', 'chunk above declared remaining size returns 413')

const completeBytes = mp4Bytes(96)
const completeInit = await init({ filename: 'complete.mp4', size: completeBytes.length, mime: 'video/mp4' })
const completeSession = await completeInit.json()
const accepted = await putChunk(completeSession.uploadId, 0, completeBytes)
assert(accepted.status === 204 && accepted.headers.get('upload-offset') === String(completeBytes.length), 'valid chunk commits exact offset')
const complete = (uploadId) => fetch(`${origin}/api/v1/uploads/${uploadId}/complete`, { method: 'POST', headers: authHeaders() })
const [completeA, completeB] = await Promise.all([complete(completeSession.uploadId), complete(completeSession.uploadId)])
const [completeBodyA, completeBodyB] = await Promise.all([completeA.json(), completeB.json()])
const repeated = await complete(completeSession.uploadId)
const repeatedBody = await repeated.json()
assert(completeA.status === 200 && completeB.status === 200, 'concurrent completes both receive an idempotent success')
assert(completeBodyA.storageKey === completeBodyB.storageKey && completeBodyA.videoHash === completeBodyB.videoHash, 'concurrent completes return the same result')
assert(repeatedBody.storageKey === completeBodyA.storageKey && repeatedBody.videoHash === completeBodyA.videoHash, 'repeated complete returns the existing result')
assert(completeBodyA.videoHash === crypto.createHash('sha256').update(completeBytes).digest('hex'), 'completion returns the actual SHA-256')

const spoofBytes = Buffer.from('<html><script>alert(1)</script></html>')
const spoofInit = await init({ filename: 'spoofed.mp4', size: spoofBytes.length, mime: 'video/mp4' })
const spoofSession = await spoofInit.json()
await putChunk(spoofSession.uploadId, 0, spoofBytes)
const spoofComplete = await complete(spoofSession.uploadId)
const spoofBody = await spoofComplete.json()
assert(spoofComplete.status === 415 && spoofBody.error.code === 'UNSUPPORTED_MEDIA_TYPE', 'HTML content masquerading as MP4 is rejected')

const multipartRequest = async (name, type, bytes) => {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type }), name)
  return fetch(`${origin}/api/v1/upload`, { method: 'POST', headers: authHeaders(), body: form })
}
const htmlMultipart = await multipartRequest('attack.html', 'text/html', Buffer.from('<html>active</html>'))
assert(htmlMultipart.status === 415, 'legacy multipart rejects HTML')
const spoofMultipart = await multipartRequest('spoofed.mp4', 'video/mp4', spoofBytes)
assert(spoofMultipart.status === 415, 'legacy multipart rejects spoofed video content')

let unsafeMkdirCalls = 0
const ancestorLegacyFs = {
  ...fs,
  promises: {
    ...fs.promises,
    async mkdir(...args) {
      unsafeMkdirCalls += 1
      return fs.promises.mkdir(...args)
    },
    async lstat(filePath) {
      if (String(filePath).endsWith(`${path.sep}tmp`)) {
        return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => true }
      }
      return fs.promises.lstat(filePath)
    },
  },
}
const unsafeLegacyApp = express()
unsafeLegacyApp.use(express.json())
unsafeLegacyApp.use('/api/v1/upload', createUploadRouter({ service, mediaProbe: null, legacyFileSystem: ancestorLegacyFs }))
const unsafeLegacyServer = unsafeLegacyApp.listen(0)
await once(unsafeLegacyServer, 'listening')
const unsafeForm = new FormData()
unsafeForm.append('file', new Blob([mp4Bytes()], { type: 'video/mp4' }), 'safe.mp4')
const unsafeLegacy = await fetch(`http://127.0.0.1:${unsafeLegacyServer.address().port}/api/v1/upload`, {
  method: 'POST',
  headers: authHeaders(),
  body: unsafeForm,
})
assert(unsafeLegacy.status === 409 && unsafeMkdirCalls === 0, 'legacy staging rejects a symlinked ancestor before any mkdir or write')
await new Promise((resolve) => unsafeLegacyServer.close(resolve))

await new Promise((resolve) => server.close(resolve))
fs.rmSync(tmpRoot, { recursive: true, force: true })
if (failures > 0) process.exit(1)
console.log('ALL PASS')
