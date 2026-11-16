// QA Comprehensive Verification Test Suite: Composer P0 Fixes
// Covers: safeMediaStatic asset serving & MIME mapping, multi-file upload rollback,
// translation IDOR isolation, and timeline audio ID / duration synchronization.
// Run: node backend/tests/qaComposerP0Verifications.test.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { v4 as uuidv4 } from 'uuid'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-qa-p0-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne } = await import('../src/db/query.js')
const { createSafeMediaStatic } = await import('../src/middleware/safeMediaStatic.js')
const { saveTimeline, processTranslation } = await import('../src/services/composerService.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const composerAssetsRouter = (await import('../src/routes/v1/composerAssets.js')).default

await initSchema()

console.log('=== QA Verification: Media Composer P0 Fixes & Guardrails ===\n')

// -------------------------------------------------------------
// SECTION 1: safeMediaStatic Media Asset Serving & Canonical MIME Types
// -------------------------------------------------------------
console.log('--- 1. safeMediaStatic Asset Serving & Canonical MIME Types ---')
{
  const storageDir = path.join(tmpRoot, 'storage')
  const projId = 'proj-static-verify'
  const assetsDir = path.join(storageDir, 'projects', projId, 'assets')
  fs.mkdirSync(assetsDir, { recursive: true })

  const testAssets = [
    { name: 'image1.png', mime: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { name: 'photo2.jpg', mime: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
    { name: 'sticker.webp', mime: 'image/webp', bytes: Buffer.from('RIFF....WEBPVP8 ', 'ascii') },
    { name: 'audio1.mp3', mime: 'audio/mpeg', bytes: Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'ascii') },
    { name: 'sound.wav', mime: 'audio/wav', bytes: Buffer.from('RIFF....WAVEfmt ', 'ascii') },
    { name: 'voice.m4a', mime: 'audio/mp4', bytes: Buffer.from('\x00\x00\x00\x20ftypM4A ', 'ascii') },
    { name: 'track.flac', mime: 'audio/flac', bytes: Buffer.from('fLaC\x00\x00\x00', 'ascii') },
    { name: 'audio2.ogg', mime: 'audio/ogg', bytes: Buffer.from('OggS\x00\x02', 'ascii') },
  ]

  for (const a of testAssets) {
    fs.writeFileSync(path.join(assetsDir, a.name), a.bytes)
  }
  // Also write non-media files that should be blocked
  fs.writeFileSync(path.join(assetsDir, 'exploit.js'), 'console.log("bad")')
  fs.writeFileSync(path.join(assetsDir, 'data.json'), '{"secret":true}')

  const app = express()
  app.use('/storage', createSafeMediaStatic({ storageDir }))
  const server = app.listen(0)
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}/storage`

  try {
    for (const a of testAssets) {
      const res = await fetch(`${baseUrl}/projects/${projId}/assets/${a.name}`)
      assert.equal(res.status, 200, `Asset ${a.name} served with 200`)
      assert.equal(res.headers.get('content-type'), a.mime, `Asset ${a.name} served with correct canonical MIME: ${a.mime}`)
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `Asset ${a.name} has nosniff`)
      console.log(`PASS: ${a.name} served as ${a.mime}`)
    }

    // Block non-media files
    for (const blocked of ['exploit.js', 'data.json']) {
      const res = await fetch(`${baseUrl}/projects/${projId}/assets/${blocked}`)
      assert.equal(res.status, 404, `Non-media file ${blocked} blocked with 404`)
      console.log(`PASS: Non-media ${blocked} denied (404)`)
    }

    // Block traversal attempts
    const traversal = await fetch(`${baseUrl}/projects/${projId}/assets/..%2F..%2Fstorage`)
    assert.equal(traversal.status, 404, 'Directory traversal denied (404)')
    console.log('PASS: Traversal attempt blocked')
  } finally {
    server.close()
  }
}

// -------------------------------------------------------------
// SECTION 2: Multi-file Upload Rollback on Partial Failure
// -------------------------------------------------------------
console.log('\n--- 2. Multi-file Upload Rollback on Partial Failure ---')
{
  const testUser = { id: 'user-rollback-1', email: 'rollback@test.local', role: 'user' }
  await insert('users', { id: testUser.id, email: testUser.email, role: 'user', password: 'hash' })
  const token = generateAccessToken(testUser)

  const projId = 'proj-rollback-1'
  await insert('projects', {
    id: projId,
    user_id: testUser.id,
    title: 'Test Rollback Project',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
  })

  const app = express()
  app.use('/api/v1/projects', composerAssetsRouter)
  const server = app.listen(0)
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/projects`

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
    // Valid PNG byte buffer
    const validPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ])
    // Invalid non-media executable
    const invalidExe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])

    const boundary = '----Boundary' + Math.random().toString(36).slice(2)
    const body = buildMultipart(boundary, { kind: 'image' }, [
      { fieldName: 'files', filename: 'valid.png', contentType: 'image/png', buffer: validPng },
      { fieldName: 'files', filename: 'invalid.exe', contentType: 'application/octet-stream', buffer: invalidExe },
    ])

    const res = await fetch(`${baseUrl}/${projId}/assets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    })

    assert.equal(res.status, 400, 'Batch with invalid media signature is rejected with 400')
    const json = await res.json()
    assert.equal(json.error?.code, 'UNSUPPORTED_MEDIA_TYPE', 'Error code is UNSUPPORTED_MEDIA_TYPE')

    // Verify zero orphaned asset records in database
    const assetsInDb = await query('SELECT * FROM assets WHERE project_id = ?', [projId])
    assert.equal(assetsInDb.length, 0, 'No asset rows remained in DB after rejected batch')

    // Verify zero files remained in project assets directory
    const pAssetsDir = path.join(process.env.STORAGE_DIR, 'projects', projId, 'assets')
    if (fs.existsSync(pAssetsDir)) {
      const filesOnDisk = fs.readdirSync(pAssetsDir)
      assert.equal(filesOnDisk.length, 0, 'No disk files orphaned in project assets dir')
    }

    console.log('PASS: Invalid batch completely rejected before persistence (0 orphans)')
  } finally {
    server.close()
  }
}

// -------------------------------------------------------------
// SECTION 3: Translation IDOR Security Enforcement
// -------------------------------------------------------------
console.log('\n--- 3. Translation IDOR Security Enforcement ---')
{
  const projOwner = { id: 'user-owner-1', email: 'owner@test.local', role: 'user' }
  const projAttacker = { id: 'user-attacker-1', email: 'attacker@test.local', role: 'user' }
  await insert('users', { id: projOwner.id, email: projOwner.email, role: 'user', password: 'hash' })
  await insert('users', { id: projAttacker.id, email: projAttacker.email, role: 'user', password: 'hash' })

  const p1 = 'proj-target-1'
  const p2 = 'proj-attacker-1'
  await insert('projects', { id: p1, user_id: projOwner.id, title: 'Owner Proj', mode: 'MEDIA_COMPOSER', status: 'queued' })
  await insert('projects', { id: p2, user_id: projAttacker.id, title: 'Attacker Proj', mode: 'MEDIA_COMPOSER', status: 'queued' })

  const asset1 = 'asset-owner-1'
  await insert('assets', {
    id: asset1,
    project_id: p1,
    user_id: projOwner.id,
    kind: 'image',
    name: 'secret.png',
    storage_key: `projects/${p1}/assets/secret.png`,
    ocr_text: 'Top Secret Document Text',
  })

  // Attacker attempts to translate asset1 under project p2
  let idorBlocked = false
  try {
    await processTranslation({
      projectId: p2,
      userId: projAttacker.id,
      assetId: asset1,
      targetLanguage: 'vi',
      text: 'Top Secret Document Text',
    })
  } catch (err) {
    idorBlocked = true
  }

  // Check if asset1 in p1 was modified
  const checkAsset = await queryOne('SELECT * FROM assets WHERE id = ?', [asset1])
  assert.equal(checkAsset.project_id, p1, 'Asset remains in p1')
  // Either processTranslation rejected with an error or did not update foreign asset
  if (checkAsset.translation_text) {
    assert.fail('Attacker was able to modify another project\'s asset translation!')
  }
  console.log('PASS: Cross-project asset translation IDOR strictly prevented')
}

// -------------------------------------------------------------
// SECTION 4: Audio ID & Duration Synchronization in saveTimeline
// -------------------------------------------------------------
console.log('\n--- 4. Audio ID & Duration Synchronization in saveTimeline ---')
{
  const userId = 'user-timeline-audio-1'
  const projId = 'proj-timeline-audio-1'
  await insert('users', { id: userId, email: 'timeline-audio@test.local', role: 'user', password: 'hash' })
  await insert('projects', { id: projId, user_id: userId, title: 'Timeline Audio Sync', mode: 'MEDIA_COMPOSER', status: 'queued' })

  // Insert test audio and asset
  const audioId = 'audio-voice-sync-1'
  await insert('audios', {
    id: audioId,
    project_id: projId,
    kind: 'voiceover',
    storage_key: `projects/${projId}/assets/voice.mp3`,
    duration_sec: 12.5,
  })
  await insert('assets', {
    id: audioId,
    project_id: projId,
    user_id: userId,
    kind: 'voiceover',
    name: 'voice.mp3',
    storage_key: `projects/${projId}/assets/voice.mp3`,
    duration_sec: 12.5,
  })

  // 4.1 Preserve audio_id, voice_audio_id, in_sec, out_sec
  const tracks = await query('SELECT * FROM timeline_tracks WHERE project_id = ?', [projId])
  const voiceTrack = tracks.find((t) => t.track_type === 'voiceover')

  const clip1 = {
    id: uuidv4(),
    track_id: voiceTrack?.id,
    clip_type: 'voiceover',
    voice_audio_id: audioId,
    audio_id: audioId,
    asset_id: audioId,
    start_at_sec: 2.0,
    in_sec: 1.0,
    out_sec: 7.5,
    volume: 0.9,
  }

  await saveTimeline({
    projectId: projId,
    tracks,
    clips: [clip1],
  })

  const saved1 = await queryOne('SELECT * FROM timeline_clips WHERE id = ?', [clip1.id])
  assert.equal(saved1.voice_audio_id, audioId, 'voice_audio_id is preserved')
  assert.equal(saved1.start_at_sec, 2.0, 'start_at_sec is preserved')
  assert.equal(saved1.in_sec, 1.0, 'in_sec is preserved')
  assert.equal(saved1.out_sec, 7.5, 'out_sec is preserved')
  console.log('PASS: Audio IDs and trim bounds preserved in saveTimeline')

  // 4.2 Duration modification correctly synchronizes out_sec
  const clip2 = {
    id: uuidv4(),
    track_id: voiceTrack?.id,
    clip_type: 'voiceover',
    voice_audio_id: audioId,
    audio_id: audioId,
    asset_id: audioId,
    start: 3.0,
    in_sec: 2.0,
    duration: 5.5, // out_sec should become in_sec + duration = 7.5
  }

  await saveTimeline({
    projectId: projId,
    tracks,
    clips: [clip1, clip2],
  })

  const saved2 = await queryOne('SELECT * FROM timeline_clips WHERE id = ?', [clip2.id])
  assert.equal(saved2.start_at_sec, 3.0, 'start mapped to start_at_sec')
  assert.equal(saved2.in_sec, 2.0, 'in_sec is 2.0')
  assert.equal(saved2.out_sec, 7.5, 'out_sec synchronized from in_sec + duration (2.0 + 5.5 = 7.5)')
  console.log('PASS: Duration update correctly synchronizes out_sec = in_sec + duration')
}

console.log('\n======================================================')
console.log(' ALL QA COMPOSER P0 VERIFICATION TESTS PASSED 100%! ')
console.log('======================================================\n')
fs.rmSync(tmpRoot, { recursive: true, force: true })
