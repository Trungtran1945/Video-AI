import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { once } from 'node:events'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-media-static-'))
let staticModule = null
try {
  staticModule = await import('../src/middleware/safeMediaStatic.js')
} catch (_) {}

let failures = 0
function assert(condition, message) {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

assert(Boolean(staticModule?.createSafeMediaStatic), 'safe media static middleware is available')
if (!staticModule?.createSafeMediaStatic) process.exit(1)

const { createSafeMediaStatic } = staticModule
const storageDir = path.join(tmpRoot, 'storage')
const files = {
  source: path.join(storageDir, 'uploads', 'source.mp4'),
  output: path.join(storageDir, 'outputs', 'result.mp4'),
  final: path.join(storageDir, 'projects', 'project-1', 'final.mkv'),
  thumbnail: path.join(storageDir, 'projects', 'project-1', 'thumb.jpg'),
  html: path.join(storageDir, 'uploads', 'attack.html'),
  privateJson: path.join(storageDir, 'projects', 'project-1', 'transcript.json'),
  temp: path.join(storageDir, 'tmp', 'upload_sessions', 'session', 'blob'),
}
for (const filePath of Object.values(files)) fs.mkdirSync(path.dirname(filePath), { recursive: true })
const video = Buffer.alloc(64)
video.writeUInt32BE(24, 0)
video.write('ftyp', 4, 'ascii')
video.write('isom', 8, 'ascii')
video.fill(7, 16)
fs.writeFileSync(files.source, video)
fs.writeFileSync(files.output, video)
fs.writeFileSync(files.final, video)
fs.writeFileSync(files.thumbnail, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
fs.writeFileSync(files.html, '<script>alert(1)</script>')
fs.writeFileSync(files.privateJson, '{"private":true}')
fs.writeFileSync(files.temp, 'partial')

const app = express()
app.use('/storage', createSafeMediaStatic({ storageDir }))
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error)
  return res.status(404).end()
})
const server = app.listen(0)
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`

for (const [url, expectedType] of [
  ['/storage/uploads/source.mp4', 'video/mp4'],
  ['/storage/outputs/result.mp4', 'video/mp4'],
  ['/storage/projects/project-1/final.mkv', 'video/x-matroska'],
  ['/storage/projects/project-1/thumb.jpg', 'image/jpeg'],
]) {
  const response = await fetch(`${origin}${url}`)
  assert(response.status === 200, `canonical media is served: ${url}`)
  assert(response.headers.get('content-type') === expectedType, `canonical MIME is forced for ${url}`)
  assert(response.headers.get('x-content-type-options') === 'nosniff', `nosniff is set for ${url}`)
  assert(response.headers.get('content-disposition') === 'inline', `inline disposition is set for ${url}`)
}

const range = await fetch(`${origin}/storage/uploads/source.mp4`, { headers: { range: 'bytes=0-3' } })
assert(range.status === 206 && Buffer.from(await range.arrayBuffer()).length === 4, 'Range playback remains supported')

const ancestorFs = {
  ...fs,
  promises: {
    ...fs.promises,
    async lstat(filePath) {
      if (String(filePath).endsWith(`${path.sep}uploads`)) {
        return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => true }
      }
      return fs.promises.lstat(filePath)
    },
  },
}
const ancestorApp = express()
ancestorApp.use('/storage', createSafeMediaStatic({ storageDir, fileSystem: ancestorFs }))
const ancestorServer = ancestorApp.listen(0)
await once(ancestorServer, 'listening')
const ancestorResponse = await fetch(`http://127.0.0.1:${ancestorServer.address().port}/storage/uploads/source.mp4`)
assert(ancestorResponse.status === 404, 'media serving rejects a symlinked storage ancestor')
await new Promise((resolve) => ancestorServer.close(resolve))

for (const url of [
  '/storage/uploads/attack.html',
  '/storage/uploads/attack.svg',
  '/storage/uploads/attack.js',
  '/storage/uploads/attack.xml',
  '/storage/projects/project-1/transcript.json',
  '/storage/tmp/upload_sessions/session/blob',
  '/storage/uploads/%2e%2e/secret.mp4',
]) {
  const response = await fetch(`${origin}${url}`)
  assert(response.status === 404, `unsafe storage path is denied: ${url}`)
}

const outside = path.join(tmpRoot, 'outside.mp4')
fs.writeFileSync(outside, video)
try {
  fs.symlinkSync(outside, path.join(storageDir, 'uploads', 'linked.mp4'))
  const linked = await fetch(`${origin}/storage/uploads/linked.mp4`)
  assert(linked.status === 404, 'media symlink is not followed')
} catch (error) {
  if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) throw error
  console.log('SKIP: filesystem symlink creation is not permitted on this host')
}

await new Promise((resolve) => server.close(resolve))
fs.rmSync(tmpRoot, { recursive: true, force: true })
if (failures > 0) process.exit(1)
console.log('ALL PASS')
