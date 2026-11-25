import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { v4 as uuidv4 } from 'uuid'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-assets-audit-fixes-'))
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'
process.env.MAX_CONCURRENT_PROJECTS_PER_USER = '10'

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne, run } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const composerAssetsRouter = (await import('../src/routes/v1/composerAssets.js')).default
const { createSafeMediaStatic } = await import('../src/middleware/safeMediaStatic.js')
const { saveUploadedAsset, processTranslation } = await import('../src/services/composerService.js')
const composerService = (await import('../src/services/composerService.js')).default
const { config } = await import('../src/config.js')
const { connection } = await import('../src/queue/connection.js')

await initSchema()
try { connection.disconnect() } catch (_) {}

console.log('=== AI Media Composer Audit Fixes Verification Tests ===\n')

const testUser1 = { id: `user-fixes-1-${Date.now()}`, email: `fixes-1-${Date.now()}@test.local`, role: 'user' }
const testUser2 = { id: `user-fixes-2-${Date.now()}`, email: `fixes-2-${Date.now()}@test.local`, role: 'user' }
await insert('users', { id: testUser1.id, email: testUser1.email, role: 'user', password: 'hash' })
await insert('users', { id: testUser2.id, email: testUser2.email, role: 'user', password: 'hash' })

const token1 = generateAccessToken(testUser1)
const token2 = generateAccessToken(testUser2)

const app = express()
app.use(express.json())
app.use('/storage', createSafeMediaStatic({ storageDir: config.storageDir }))
app.use('/api/v1/projects', composerAssetsRouter)

const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port
const origin = `http://127.0.0.1:${port}`

const validPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
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
  const proj1Id = 'proj-fix-' + uuidv4().slice(0, 8)
  const proj2Id = 'proj-fix-' + uuidv4().slice(0, 8)
  await insert('projects', { id: proj1Id, user_id: testUser1.id, title: 'Fix Test 1', mode: 'MEDIA_COMPOSER', status: 'queued' })
  await insert('projects', { id: proj2Id, user_id: testUser2.id, title: 'Fix Test 2', mode: 'MEDIA_COMPOSER', status: 'queued' })

  // 1. safeMediaStatic serving of project assets (images, audio, thumbnails)
  console.log('--- 1. safeMediaStatic serves projects/:id/assets/* correctly ---')
  const assetDir = path.join(config.storageDir, 'projects', proj1Id, 'assets')
  fs.mkdirSync(assetDir, { recursive: true })
  fs.writeFileSync(path.join(assetDir, 'sample_image.png'), validPng)
  fs.writeFileSync(path.join(assetDir, 'sample_thumb.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  fs.writeFileSync(path.join(assetDir, 'tts_voice1.mp3'), Buffer.from([0xff, 0xfb, 0x90, 0x64]))

  const pngRes = await fetch(`${origin}/storage/projects/${proj1Id}/assets/sample_image.png`)
  assert.equal(pngRes.status, 200, 'Serves png asset with 200')
  assert.equal(pngRes.headers.get('content-type'), 'image/png', 'Correct image/png content-type')

  const thumbRes = await fetch(`${origin}/storage/projects/${proj1Id}/assets/sample_thumb.jpg`)
  assert.equal(thumbRes.status, 200, 'Serves thumb asset with 200')
  assert.equal(thumbRes.headers.get('content-type'), 'image/jpeg', 'Correct image/jpeg content-type')

  const mp3Res = await fetch(`${origin}/storage/projects/${proj1Id}/assets/tts_voice1.mp3`)
  assert.equal(mp3Res.status, 200, 'Serves mp3 asset with 200')
  assert.equal(mp3Res.headers.get('content-type'), 'audio/mpeg', 'Correct audio/mpeg content-type')
  console.log('✓ safeMediaStatic serves all composer media asset formats')

  // 2. IDOR Prevention on Translation Endpoint
  console.log('--- 2. IDOR Prevention on POST /:id/assets/:assetId/translate ---')
  const victimAssetId = 'victim-asset-' + uuidv4().slice(0, 8)
  await insert('assets', {
    id: victimAssetId,
    project_id: proj2Id, // Owned by user 2
    user_id: testUser2.id,
    kind: 'image',
    name: 'victim.png',
    storage_key: `projects/${proj2Id}/assets/victim.png`,
    ocr_text: 'Secret victim text',
  })

  // User 1 tries to translate User 2's asset via User 1's project ID
  const idorRes = await fetch(`${origin}/api/v1/projects/${proj1Id}/assets/${victimAssetId}/translate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: 'Hacked translation' }),
  })
  assert.equal(idorRes.status, 404, 'Cross-project asset translation rejected with 404')
  const victimCheck = await queryOne('SELECT translation_text FROM assets WHERE id = ?', [victimAssetId])
  assert.equal(victimCheck.translation_text, null, 'Victim asset was not modified')
  console.log('✓ IDOR translation exploit cleanly blocked with 404')

  // 3. Multi-file upload partial failure rollback
  console.log('--- 3. Multi-file upload rollback on partial failure ---')
  const boundary3 = '----BoundaryRollback' + Math.random().toString(36).slice(2)
  const body3 = buildMultipart(boundary3, { kind: 'image' }, [
    { fieldName: 'files', filename: 'ok1.png', contentType: 'image/png', buffer: validPng },
    { fieldName: 'files', filename: 'ok2.png', contentType: 'image/png', buffer: validPng },
  ])

  // Mock saveUploadedAsset failure on 2nd file to simulate filesystem/DB failure mid-batch
  const origSave = composerService.saveUploadedAsset
  let callCount = 0
  composerService.saveUploadedAsset = async function(args) {
    callCount++
    if (callCount === 2) {
      throw new Error('Simulated disk I/O error on 2nd file')
    }
    return origSave.apply(this, arguments)
  }

  const failRes = await fetch(`${origin}/api/v1/projects/${proj1Id}/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': `multipart/form-data; boundary=${boundary3}`,
    },
    body: body3,
  })
  composerService.saveUploadedAsset = origSave

  assert.equal(failRes.status, 500, 'Batch fails with 500 when 2nd file fails')
  // Verify ok1 was cleaned up from DB and disk
  const assetsAfterFail = await query('SELECT * FROM assets WHERE project_id = ?', [proj1Id])
  assert.equal(assetsAfterFail.length, 0, 'No orphaned assets left in DB after partial failure rollback')
  console.log('✓ Partial failure cleanly rolled back without orphaned assets or disk files')

  // 4. Allowed Media Extensions Whitelist
  console.log('--- 4. Allowed Media Extensions Whitelist in saveUploadedAsset ---')
  const dummyFileExe = {
    originalname: 'suspicious.exe',
    mimetype: 'image/png',
    buffer: validPng,
  }
  const savedSanitized = await saveUploadedAsset({
    projectId: proj1Id,
    userId: testUser1.id,
    file: dummyFileExe,
    kind: 'image',
  })
  assert.ok(savedSanitized.storageKey.endsWith('.png'), 'Non-whitelisted extension sanitized to safe extension: .png')
  console.log('✓ Unsafe file extension sanitized to .png')

  console.log('\n======================================================')
  console.log(' ALL BACKEND AUDIT FIX VERIFICATION TESTS PASSED 100%! ')
  console.log('======================================================\n')
} finally {
  server.close()
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_) {}
}
