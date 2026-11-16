import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { v4 as uuidv4 } from 'uuid'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-composer-resilience-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'
process.env.MAX_CONCURRENT_PROJECTS_PER_USER = '10'

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const composerAssetsRouter = (await import('../src/routes/v1/composerAssets.js')).default
const { config, isOriginAllowed } = await import('../src/config.js')
const { connection } = await import('../src/queue/connection.js')

await initSchema()
try { connection.disconnect() } catch (_) {}

console.log('=== AI Media Composer Upload & Network Resilience Test Suite ===\n')

const testUser = { id: 'user-comp-resil-1', email: 'comp-resil@test.local', role: 'user' }
await insert('users', { id: testUser.id, email: testUser.email, role: 'user', password: 'hash' })
const token = generateAccessToken(testUser)

const app = express()
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true)
    if (isOriginAllowed(origin)) return callback(null, true)
    callback(new Error(`CORS: origin not allowed: ${origin}`))
  },
  credentials: true,
}))
app.use('/api/v1/projects', composerAssetsRouter)

const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/api/v1/projects`

// Media test byte buffers
const validSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>', 'utf8')
const validSvgXml = Buffer.from('<?xml version="1.0" encoding="utf-8"?><svg width="20" height="20"></svg>', 'utf8')
const validBmp = Buffer.from([0x42, 0x4d, 0x3a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00])
const validM4a = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x00, 0x00])
const validAac = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
const validMp4Wide = Buffer.from([
  0x00, 0x00, 0x00, 0x08, 0x77, 0x69, 0x64, 0x65, // 'wide' atom
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
])
const invalidExecutable = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00])

function buildMultipart(boundary, fields, files) {
  const parts = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'))
  }
  for (const f of files) {
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="${f.fieldName || 'files'}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType}\r\n\r\n`
    parts.push(Buffer.from(header, 'utf8'))
    parts.push(f.buffer)
    parts.push(Buffer.from('\r\n', 'utf8'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return Buffer.concat(parts)
}

try {
  const projId = 'proj-resilience-' + uuidv4().slice(0, 8)
  await insert('projects', {
    id: projId,
    user_id: testUser.id,
    title: 'Test Media Resilience',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
  })

  // 1. CORS allowlist verification for IPv4 (127.0.0.1) and localhost
  console.log('--- 1. CORS Origins: IPv4 127.0.0.1 and localhost ---')
  assert.equal(isOriginAllowed('http://localhost:5173'), true, 'Allows localhost:5173')
  assert.equal(isOriginAllowed('http://127.0.0.1:5173'), true, 'Allows 127.0.0.1:5173')
  assert.equal(isOriginAllowed('http://127.0.0.1:3000'), true, 'Allows 127.0.0.1:3000')
  assert.equal(isOriginAllowed('http://127.0.0.1:4173'), true, 'Allows 127.0.0.1:4173')
  assert.equal(isOriginAllowed('http://evil-attacker.com'), false, 'Rejects untrusted origin')

  // Verify preflight OPTIONS on server with 127.0.0.1:5173
  const preflightRes = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://127.0.0.1:5173',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Authorization, Content-Type',
    },
  })
  assert.equal(preflightRes.status, 204, 'Preflight OPTIONS returns 204 for 127.0.0.1:5173')
  assert.equal(preflightRes.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173', 'CORS allow origin matched')
  console.log('✓ CORS allowlist for IPv4 127.0.0.1:5173 verified')

  // 2. Upload SVG image format
  console.log('--- 2. Upload SVG image format ---')
  const boundarySvg = '----Boundary' + Math.random().toString(36).slice(2)
  const resSvg = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': `multipart/form-data; boundary=${boundarySvg}`,
    },
    body: buildMultipart(boundarySvg, { kind: 'image' }, [
      { fieldName: 'files', filename: 'logo.svg', contentType: 'image/svg+xml', buffer: validSvg },
    ]),
  })
  assert.equal(resSvg.status, 200, 'Upload SVG returns 200')
  const dataSvg = await resSvg.json()
  assert.equal(dataSvg.assets[0].name, 'logo.svg')
  console.log('✓ SVG image upload verified')

  // 3. Upload BMP image format
  console.log('--- 3. Upload BMP image format ---')
  const boundaryBmp = '----Boundary' + Math.random().toString(36).slice(2)
  const resBmp = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': `multipart/form-data; boundary=${boundaryBmp}`,
    },
    body: buildMultipart(boundaryBmp, { kind: 'image' }, [
      { fieldName: 'files', filename: 'graphic.bmp', contentType: 'image/bmp', buffer: validBmp },
    ]),
  })
  assert.equal(resBmp.status, 200, 'Upload BMP returns 200')
  const dataBmp = await resBmp.json()
  assert.equal(dataBmp.assets[0].name, 'graphic.bmp')
  console.log('✓ BMP image upload verified')

  // 4. Upload M4A audio format
  console.log('--- 4. Upload M4A audio format ---')
  const boundaryM4a = '----Boundary' + Math.random().toString(36).slice(2)
  const resM4a = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': `multipart/form-data; boundary=${boundaryM4a}`,
    },
    body: buildMultipart(boundaryM4a, { kind: 'voiceover' }, [
      { fieldName: 'files', filename: 'speech.m4a', contentType: 'audio/m4a', buffer: validM4a },
    ]),
  })
  assert.equal(resM4a.status, 200, 'Upload M4A returns 200')
  const dataM4a = await resM4a.json()
  assert.equal(dataM4a.assets[0].name, 'speech.m4a')
  console.log('✓ M4A audio upload verified')

  // 5. Upload AAC audio format
  console.log('--- 5. Upload AAC audio format ---')
  const boundaryAac = '----Boundary' + Math.random().toString(36).slice(2)
  const resAac = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': `multipart/form-data; boundary=${boundaryAac}`,
    },
    body: buildMultipart(boundaryAac, { kind: 'music' }, [
      { fieldName: 'files', filename: 'sound.aac', contentType: 'audio/aac', buffer: validAac },
    ]),
  })
  assert.equal(resAac.status, 200, 'Upload AAC returns 200')
  const dataAac = await resAac.json()
  assert.equal(dataAac.assets[0].name, 'sound.aac')
  console.log('✓ AAC audio upload verified')

  // 6. Upload MP4 with 'wide' atom prefix
  console.log('--- 6. Upload MP4 with wide atom prefix ---')
  const boundaryWide = '----Boundary' + Math.random().toString(36).slice(2)
  const resWide = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': `multipart/form-data; boundary=${boundaryWide}`,
    },
    body: buildMultipart(boundaryWide, { kind: 'video' }, [
      { fieldName: 'files', filename: 'camera_raw.mp4', contentType: 'video/mp4', buffer: validMp4Wide },
    ]),
  })
  assert.equal(resWide.status, 200, 'Upload MP4 with wide atom returns 200')
  const dataWide = await resWide.json()
  assert.equal(dataWide.assets[0].name, 'camera_raw.mp4')
  console.log('✓ MP4 with wide atom upload verified')

  // 7. Security: Reject non-media executable
  console.log('--- 7. Security: Reject non-media executable ---')
  const boundaryExe = '----Boundary' + Math.random().toString(36).slice(2)
  const resExe = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': `multipart/form-data; boundary=${boundaryExe}`,
    },
    body: buildMultipart(boundaryExe, { kind: 'video' }, [
      { fieldName: 'files', filename: 'malicious.exe', contentType: 'application/x-msdownload', buffer: invalidExecutable },
    ]),
  })
  assert.equal(resExe.status, 400, 'Rejects executable with 400')
  const dataExe = await resExe.json()
  assert.equal(dataExe.error?.code, 'UNSUPPORTED_MEDIA_TYPE', 'Returns UNSUPPORTED_MEDIA_TYPE code')
  console.log('✓ Non-media executable cleanly rejected with 400 UNSUPPORTED_MEDIA_TYPE')

  console.log('\n================================================================')
  console.log(' ALL UPLOAD & NETWORK RESILIENCE TESTS PASSED 100%! ')
  console.log('================================================================\n')
} finally {
  server.close()
}
