import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { v4 as uuidv4 } from 'uuid'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-composer-upload-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'
process.env.MAX_CONCURRENT_PROJECTS_PER_USER = '10'

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const composerAssetsRouter = (await import('../src/routes/v1/composerAssets.js')).default
const { config } = await import('../src/config.js')
const { connection } = await import('../src/queue/connection.js')

await initSchema()
try { connection.disconnect() } catch (_) {}

console.log('=== AI Media Composer Upload System & Network Diagnostics Tests ===\n')

const testUser1 = { id: 'user-comp-up-1', email: 'comp-up-1@test.local', role: 'user' }
const testUser2 = { id: 'user-comp-up-2', email: 'comp-up-2@test.local', role: 'user' }

await insert('users', { id: testUser1.id, email: testUser1.email, role: 'user', password: 'hash' })
await insert('users', { id: testUser2.id, email: testUser2.email, role: 'user', password: 'hash' })

const token1 = generateAccessToken(testUser1)
const token2 = generateAccessToken(testUser2)

const app = express()
app.use('/api/v1/projects', composerAssetsRouter)

const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/api/v1/projects`

// 1x1 PNG bytes
const validPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

// GIF89a header + minimal trailer
const validGif = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
])

// FLAC header
const validFlac = Buffer.from([
  0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22, 0x10, 0x00, 0x10, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])

// MP4 ftyp box header
const validMp4 = Buffer.from([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  0x61, 0x76, 0x63, 0x31,
])

// MP3 sync frame
const validMp3 = Buffer.from([
  0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
])

// WebM EBML header
const validWebm = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81,
  0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84,
  0x77, 0x65, 0x62, 0x6d,
])

// OGG container header (OggS)
const validOgg = Buffer.from([
  0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x12, 0x34, 0x56, 0x78, 0x00, 0x00, 0x00, 0x00, 0x12, 0x34,
  0x56, 0x78, 0x01, 0x1e,
])

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
  const projId = 'proj-upload-audit-' + uuidv4().slice(0, 8)
  await insert('projects', {
    id: projId,
    user_id: testUser1.id,
    title: 'Test Upload Diagnostics',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
  })

  // 1. Root cause verification: Missing boundary returns 400 MALFORMED_MULTIPART
  console.log('--- 1. Root Cause: Missing boundary returns 400 MALFORMED_MULTIPART ---')
  const noBoundaryRes = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': 'multipart/form-data', // Missing boundary!
    },
    body: 'plain body',
  })
  assert.equal(noBoundaryRes.status, 400, 'Rejects header missing boundary with 400')
  const noBoundaryData = await noBoundaryRes.json()
  assert.equal(noBoundaryData.error?.code, 'MALFORMED_MULTIPART', 'Returns MALFORMED_MULTIPART code')
  console.log('✓ Missing boundary cleanly rejected with 400 MALFORMED_MULTIPART')

  // 2. Upload valid PNG image
  console.log('--- 2. Upload valid PNG image ---')
  const boundary2 = '----Boundary' + Math.random().toString(36).slice(2)
  const body2 = buildMultipart(boundary2, { kind: 'image' }, [
    { fieldName: 'files', filename: 'photo.png', contentType: 'image/png', buffer: validPng },
  ])
  const res2 = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': `multipart/form-data; boundary=${boundary2}`,
    },
    body: body2,
  })
  assert.equal(res2.status, 200, 'Upload PNG returns 200')
  const data2 = await res2.json()
  assert.ok(Array.isArray(data2.assets), 'Returns assets array')
  assert.equal(data2.assets.length, 1, 'Contains 1 asset')
  const asset1 = data2.assets[0]
  assert.equal(asset1.name, 'photo.png')
  assert.equal(asset1.kind, 'image')
  assert.ok(asset1.storageKey.includes('projects/' + projId))
  assert.ok(asset1.url.startsWith('/storage/'))
  assert.ok(asset1.byteSize > 0)
  assert.equal(asset1.project_id, projId, 'Dual-compatibility project_id present')
  console.log('✓ Valid PNG uploaded and persisted')

  // 3. Upload valid GIF image
  console.log('--- 3. Upload valid GIF image ---')
  const boundaryGif = '----Boundary' + Math.random().toString(36).slice(2)
  const bodyGif = buildMultipart(boundaryGif, { kind: 'image' }, [
    { fieldName: 'files', filename: 'animation.gif', contentType: 'image/gif', buffer: validGif },
  ])
  const resGif = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': `multipart/form-data; boundary=${boundaryGif}`,
    },
    body: bodyGif,
  })
  assert.equal(resGif.status, 200, 'Upload GIF returns 200')
  const dataGif = await resGif.json()
  assert.equal(dataGif.assets[0].name, 'animation.gif')
  console.log('✓ Valid GIF recognized and uploaded')

  // 4. Upload valid MP4 video
  console.log('--- 4. Upload valid MP4 video ---')
  const boundaryMp4 = '----Boundary' + Math.random().toString(36).slice(2)
  const bodyMp4 = buildMultipart(boundaryMp4, { kind: 'video' }, [
    { fieldName: 'files', filename: 'clip.mp4', contentType: 'video/mp4', buffer: validMp4 },
  ])
  const resMp4 = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': `multipart/form-data; boundary=${boundaryMp4}`,
    },
    body: bodyMp4,
  })
  assert.equal(resMp4.status, 200, 'Upload MP4 returns 200')
  const dataMp4 = await resMp4.json()
  assert.equal(dataMp4.assets[0].kind, 'video')
  console.log('✓ Valid MP4 recognized and uploaded')

  // 5. Upload valid MP3 audio
  console.log('--- 5. Upload valid MP3 audio ---')
  const boundaryMp3 = '----Boundary' + Math.random().toString(36).slice(2)
  const bodyMp3 = buildMultipart(boundaryMp3, { kind: 'music' }, [
    { fieldName: 'files', filename: 'track.mp3', contentType: 'audio/mpeg', buffer: validMp3 },
  ])
  const resMp3 = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': `multipart/form-data; boundary=${boundaryMp3}`,
    },
    body: bodyMp3,
  })
  assert.equal(resMp3.status, 200, 'Upload MP3 returns 200')
  const dataMp3 = await resMp3.json()
  assert.equal(dataMp3.assets[0].kind, 'music')
  console.log('✓ Valid MP3 recognized and uploaded')

  // 6. Upload valid FLAC audio
  console.log('--- 6. Upload valid FLAC audio ---')
  const boundaryFlac = '----Boundary' + Math.random().toString(36).slice(2)
  const bodyFlac = buildMultipart(boundaryFlac, { kind: 'music' }, [
    { fieldName: 'files', filename: 'song.flac', contentType: 'audio/flac', buffer: validFlac },
  ])
  const resFlac = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': `multipart/form-data; boundary=${boundaryFlac}`,
    },
    body: bodyFlac,
  })
  assert.equal(resFlac.status, 200, 'Upload FLAC returns 200')
  const dataFlac = await resFlac.json()
  assert.equal(dataFlac.assets[0].kind, 'music')
  console.log('✓ Valid FLAC recognized and uploaded')

  // 7. Spoofed payload / invalid magic bytes rejected
  console.log('--- 7. Spoofed payload rejected with 400 UNSUPPORTED_MEDIA_TYPE ---')
  const boundaryFake = '----Boundary' + Math.random().toString(36).slice(2)
  const fakeBuffer = Buffer.from('NOT_A_VALID_MEDIA_HEADER_JUST_RANDOM_TEXT')
  const bodyFake = buildMultipart(boundaryFake, { kind: 'image' }, [
    { fieldName: 'files', filename: 'spoofed.png', contentType: 'image/png', buffer: fakeBuffer },
  ])
  const resFake = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': `multipart/form-data; boundary=${boundaryFake}`,
    },
    body: bodyFake,
  })
  assert.equal(resFake.status, 400, 'Spoofed file rejected with 400')
  const dataFake = await resFake.json()
  assert.equal(dataFake.error?.code, 'UNSUPPORTED_MEDIA_TYPE')
  console.log('✓ Spoofed media cleanly rejected')

  // 8. Empty files field rejected with 400 VAL_001
  console.log('--- 8. Empty files field rejected with 400 ---')
  const boundaryEmpty = '----Boundary' + Math.random().toString(36).slice(2)
  const bodyEmpty = buildMultipart(boundaryEmpty, { kind: 'image' }, [])
  const resEmpty = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': `multipart/form-data; boundary=${boundaryEmpty}`,
    },
    body: bodyEmpty,
  })
  assert.equal(resEmpty.status, 400, 'Empty upload rejected with 400')
  console.log('✓ Empty upload rejected')

  // 9. Unauthorized / Foreign user gets 403
  console.log('--- 9. Non-owner gets 403 Forbidden ---')
  const resForeign = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token2}`,
      'Content-Type': `multipart/form-data; boundary=${boundary2}`,
    },
    body: body2,
  })
  assert.equal(resForeign.status, 403, 'Foreign user gets 403')
  console.log('✓ Ownership authorization enforced')

  // 10. GET /api/v1/projects/:id/assets returns all uploaded assets
  console.log('--- 10. GET /api/v1/projects/:id/assets lists all uploaded assets ---')
  const resList = await fetch(`${baseUrl}/${projId}/assets`, {
    headers: { Authorization: `Bearer ${token1}` },
  })
  assert.equal(resList.status, 200)
  const listData = await resList.json()
  assert.equal(listData.assets.length, 5, '5 assets listed (PNG, GIF, MP4, MP3, FLAC)')
  console.log('✓ Asset retrieval lists all 5 uploaded media items correctly')

  // 11. Upload valid WebM video
  console.log('--- 11. Upload valid WebM video ---')
  const boundaryWebm = '----Boundary' + Math.random().toString(36).slice(2)
  const bodyWebm = buildMultipart(boundaryWebm, { kind: 'video' }, [
    { fieldName: 'files', filename: 'clip.webm', contentType: 'video/webm', buffer: validWebm },
  ])
  const resWebm = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': `multipart/form-data; boundary=${boundaryWebm}`,
    },
    body: bodyWebm,
  })
  assert.equal(resWebm.status, 200, 'Upload WebM returns 200')
  const dataWebm = await resWebm.json()
  assert.equal(dataWebm.assets[0].kind, 'video')
  console.log('✓ Valid WebM recognized and uploaded')

  // 12. Upload valid OGG audio
  console.log('--- 12. Upload valid OGG audio ---')
  const boundaryOgg = '----Boundary' + Math.random().toString(36).slice(2)
  const bodyOgg = buildMultipart(boundaryOgg, { kind: 'music' }, [
    { fieldName: 'files', filename: 'sound.ogg', contentType: 'audio/ogg', buffer: validOgg },
  ])
  const resOgg = await fetch(`${baseUrl}/${projId}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': `multipart/form-data; boundary=${boundaryOgg}`,
    },
    body: bodyOgg,
  })
  assert.equal(resOgg.status, 200, 'Upload OGG returns 200')
  const dataOgg = await resOgg.json()
  assert.equal(dataOgg.assets[0].kind, 'music')
  console.log('✓ Valid OGG recognized and uploaded')

  // 13. Client Abort / Socket close cleanup test
  console.log('--- 13. Client abort socket close cleanup test ---')
  const tmpUploadsDir = path.join(config.storageDir, 'tmp_uploads')
  const beforeFiles = fs.existsSync(tmpUploadsDir) ? fs.readdirSync(tmpUploadsDir) : []
  const abortBoundary = '----AbortBoundary' + Math.random().toString(36).slice(2)
  const abortCtrl = new AbortController()

  try {
    const uploadPromise = fetch(`${baseUrl}/${projId}/assets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token1}`,
        'Content-Type': `multipart/form-data; boundary=${abortBoundary}`,
      },
      body: buildMultipart(abortBoundary, { kind: 'image' }, [
        { fieldName: 'files', filename: 'cancelled.png', contentType: 'image/png', buffer: validPng },
      ]),
      signal: abortCtrl.signal,
    })
    // Abort immediately
    abortCtrl.abort()
    await uploadPromise
  } catch (abortErr) {
    assert.ok(abortErr.name === 'AbortError' || abortErr.code === 'ABORT_ERR', 'Fetch aborted successfully')
  }

  // Small delay for socket close event
  await new Promise((r) => setTimeout(r, 100))
  const afterFiles = fs.existsSync(tmpUploadsDir) ? fs.readdirSync(tmpUploadsDir) : []
  assert.equal(afterFiles.length, beforeFiles.length, 'No leftover temporary files in tmp_uploads after abort')
  console.log('✓ Abort socket cleanup verified without leftover temporary files')

  console.log('\n================================================================')
  console.log(' ALL AI MEDIA COMPOSER UPLOAD & DIAGNOSTICS TESTS PASSED 100%! ')
  console.log('================================================================\n')
} finally {
  server.close()
}
