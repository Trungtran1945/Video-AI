// Test suite: Verification of Extended Media Signatures (SVG, BMP, AAC, M4A, MP4 atoms)
// Run: node backend/tests/composerMediaSignatures.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { v4 as uuidv4 } from 'uuid'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-sig-test-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const { insert } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const composerAssetsRouter = (await import('../src/routes/v1/composerAssets.js')).default

await initSchema()

const testUser = { id: 'user-sig-1', email: 'sig-test@test.local', role: 'user' }
await insert('users', { id: testUser.id, email: testUser.email, role: 'user', password: 'hash' })
const token = generateAccessToken(testUser)

const app = express()
app.use('/api/v1/projects', composerAssetsRouter)
const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/api/v1/projects`

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

async function uploadFile(projId, filename, contentType, buffer, kind = 'image') {
  const boundary = '----Boundary' + Math.random().toString(36).slice(2)
  const body = buildMultipart(boundary, { kind }, [
    { fieldName: 'files', filename, contentType, buffer },
  ])
  return fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  })
}

console.log('=== Test Extended Media Signatures (SVG, BMP, AAC, M4A, MP4 wide/free) ===\n')

const projId = 'proj-sig-' + uuidv4().slice(0, 8)
await insert('projects', {
  id: projId,
  user_id: testUser.id,
  title: 'Test Signatures Project',
  mode: 'MEDIA_COMPOSER',
  status: 'queued',
})

// 1. SVG
{
  const svgBuffer = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="red"/></svg>', 'utf8')
  const res = await uploadFile(projId, 'icon.svg', 'image/svg+xml', svgBuffer, 'image')
  assert.equal(res.status, 200, 'SVG upload returns 200')
  const data = await res.json()
  assert.equal(data.assets.length, 1)
  assert.equal(data.assets[0].name, 'icon.svg')
  console.log('PASS: SVG vector image accepted')
}

// 2. BMP
{
  const bmpBuffer = Buffer.from([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00])
  const res = await uploadFile(projId, 'bitmap.bmp', 'image/bmp', bmpBuffer, 'image')
  assert.equal(res.status, 200, 'BMP upload returns 200')
  console.log('PASS: BMP image accepted')
}

// 3. AAC (ADTS frame)
{
  const aacBuffer = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc, 0x00, 0x00, 0x00])
  const res = await uploadFile(projId, 'voice.aac', 'audio/aac', aacBuffer, 'voiceover')
  assert.equal(res.status, 200, 'AAC upload returns 200')
  console.log('PASS: AAC audio accepted')
}

// 4. M4A / MP4 with wide atom before ftyp
{
  const m4aBuffer = Buffer.from([
    0x00, 0x00, 0x00, 0x08, 0x77, 0x69, 0x64, 0x65, // wide atom
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, // ftypM4A
  ])
  const res = await uploadFile(projId, 'audio.m4a', 'audio/mp4', m4aBuffer, 'music')
  assert.equal(res.status, 200, 'M4A with wide atom returns 200')
  console.log('PASS: M4A with wide atom accepted')
}

// 5. MP4 with free atom at beginning
{
  const mp4FreeBuffer = Buffer.from([
    0x00, 0x00, 0x00, 0x08, 0x66, 0x72, 0x65, 0x65, // free atom
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  ])
  const res = await uploadFile(projId, 'video.mp4', 'video/mp4', mp4FreeBuffer, 'video')
  assert.equal(res.status, 200, 'MP4 with free atom returns 200')
  console.log('PASS: MP4 with free atom accepted')
}

server.close()
console.log('\nALL EXTENDED MEDIA SIGNATURE TESTS PASS!')
