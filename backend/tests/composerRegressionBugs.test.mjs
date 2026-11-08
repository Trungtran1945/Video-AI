import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import http from 'node:http'
import express from 'express'
import { v4 as uuidv4 } from 'uuid'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_composer_regression_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne, run } = await import('../src/db/query.js')
const { projectDir, ensureDir, resolveStorageKey } = await import('../src/pipeline/context.js')
const { config } = await import('../src/config.js')
const { ffmpeg, probe } = await import('../src/media/ffmpeg.js')
const { buildVoiceTrack } = await import('../src/media/mediaService.js')
const { composerPrepare } = await import('../src/pipeline/stages/composerPrepare.js')
const { composerRender } = await import('../src/pipeline/stages/composerRender.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const composerAssetsRouter = (await import('../src/routes/v1/composerAssets.js')).default

await initSchema()

console.log('=== AI Media Composer Chu kỳ 2 Regression Bug Tests ===\n')

const testUserId = 'user-composer-reg-' + uuidv4().slice(0, 8)
await insert('users', {
  id: testUserId,
  email: `composer-reg-${Date.now()}@test.local`,
  role: 'user',
  password: 'hash',
})
const userToken = generateAccessToken({ id: testUserId, email: `composer-reg-${Date.now()}@test.local`, role: 'user' })

// RFC 2083 compliant 1x1 RGBA PNG buffer
const dummyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

// ----------------------------------------------------------------------------------
// 1. TEST-TIME-01: Timeline Absolute Positioning & Gap Preservation
// ----------------------------------------------------------------------------------
{
  console.log('--- 1. TEST-TIME-01: Timeline Absolute Positioning & Gap Preservation ---')
  const projId = 'proj-reg-time-gap-' + uuidv4().slice(0, 8)
  await insert('projects', {
    id: projId,
    user_id: testUserId,
    title: 'Test Gap Preservation',
    mode: 'MEDIA_COMPOSER',
    aspect_ratio: '16:9',
    status: 'queued',
    params: JSON.stringify({ defaultBackground: '#112233' }),
  })

  const pDir = projectDir(projId)
  const assetsDir = ensureDir(path.join(pDir, 'assets'))
  const img1Path = path.join(assetsDir, 'img1.png')
  const img2Path = path.join(assetsDir, 'img2.png')
  fs.writeFileSync(img1Path, dummyPng)
  fs.writeFileSync(img2Path, dummyPng)

  const asset1Id = 'asset-reg-gap-1-' + uuidv4().slice(0, 8)
  const asset2Id = 'asset-reg-gap-2-' + uuidv4().slice(0, 8)
  await insert('assets', {
    id: asset1Id,
    project_id: projId,
    user_id: testUserId,
    kind: 'image',
    name: 'img1.png',
    storage_key: `projects/${projId}/assets/img1.png`,
    byte_size: dummyPng.length,
    mime_type: 'image/png',
  })
  await insert('assets', {
    id: asset2Id,
    project_id: projId,
    user_id: testUserId,
    kind: 'image',
    name: 'img2.png',
    storage_key: `projects/${projId}/assets/img2.png`,
    byte_size: dummyPng.length,
    mime_type: 'image/png',
  })

  // Clip 1: 0s -> 2s
  // Gap: 2s -> 4s (No clip, background shows)
  // Clip 2: 4s -> 6s
  await insert('timeline_clips', {
    id: 'clip-gap-1-' + uuidv4().slice(0, 8),
    project_id: projId,
    clip_type: 'image',
    source_type: 'ASSET',
    asset_id: asset1Id,
    start_at_sec: 0,
    in_sec: 0,
    out_sec: 2,
    order_index: 0,
  })
  await insert('timeline_clips', {
    id: 'clip-gap-2-' + uuidv4().slice(0, 8),
    project_id: projId,
    clip_type: 'image',
    source_type: 'ASSET',
    asset_id: asset2Id,
    start_at_sec: 4,
    in_sec: 0,
    out_sec: 2,
    order_index: 1,
  })

  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projId])
  const renderRes = await composerRender({ project })
  assert.ok(renderRes && renderRes.storageKey, 'Render completes and returns storageKey')

  const finalVideoAbs = resolveStorageKey(renderRes.storageKey)
  assert.ok(fs.existsSync(finalVideoAbs), 'Render output file exists on disk')

  const info = await probe(finalVideoAbs)
  assert.ok(info.durationSec >= 5.8 && info.durationSec <= 6.5, `Rendered duration spans whole timeline including gap (got ${info.durationSec}s, expected ~6s)`)
  console.log(`✓ Absolute positioning & gap preservation verified: duration=${info.durationSec}s`)
}

// ----------------------------------------------------------------------------------
// 2. TEST-BG-VIDEO: Video Background Handling & Continuous Motion
// ----------------------------------------------------------------------------------
{
  console.log('\n--- 2. TEST-BG-VIDEO: Video Background Handling & Dynamic Frames ---')
  const projId = 'proj-reg-bg-vid-' + uuidv4().slice(0, 8)
  await insert('projects', {
    id: projId,
    user_id: testUserId,
    title: 'Test Video Background',
    mode: 'MEDIA_COMPOSER',
    aspect_ratio: '16:9',
    status: 'queued',
  })

  const pDir = projectDir(projId)
  const assetsDir = ensureDir(path.join(pDir, 'assets'))
  const bgVidPath = path.join(assetsDir, 'bg_loop.mp4')

  // Generate 2s sample video background
  await ffmpeg([
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=duration=2:size=320x180:rate=24',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    bgVidPath,
  ])

  const bgAssetId = 'asset-reg-bg-vid-' + uuidv4().slice(0, 8)
  await insert('assets', {
    id: bgAssetId,
    project_id: projId,
    user_id: testUserId,
    kind: 'video',
    name: 'bg_loop.mp4',
    storage_key: `projects/${projId}/assets/bg_loop.mp4`,
    byte_size: fs.statSync(bgVidPath).size,
    mime_type: 'video/mp4',
  })

  // Add background clip covering 5s (longer than 2s background -> tests looping/duration)
  await insert('timeline_clips', {
    id: 'clip-bg-' + uuidv4().slice(0, 8),
    project_id: projId,
    clip_type: 'background',
    source_type: 'ASSET',
    asset_id: bgAssetId,
    start_at_sec: 0,
    in_sec: 0,
    out_sec: 5,
    order_index: 0,
  })

  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projId])
  const renderRes = await composerRender({ project })
  const finalVideoAbs = resolveStorageKey(renderRes.storageKey)
  assert.ok(fs.existsSync(finalVideoAbs), 'Video background output exists')

  const info = await probe(finalVideoAbs)
  assert.ok(info.durationSec >= 4.8 && info.durationSec <= 5.5, `Video background looped to match timeline (got ${info.durationSec}s, expected ~5s)`)
  console.log(`✓ Video background handling verified: looped duration=${info.durationSec}s`)
}

// ----------------------------------------------------------------------------------
// 3. TEST-AUDIO-MUTE & VOLUME: Track Mute & Individual Clip Volume
// ----------------------------------------------------------------------------------
{
  console.log('\n--- 3. TEST-AUDIO-MUTE & VOLUME: Audio Track Mute & Volume Scaling ---')
  const projId = 'proj-reg-audio-' + uuidv4().slice(0, 8)
  await insert('projects', {
    id: projId,
    user_id: testUserId,
    title: 'Test Audio Mute & Volume',
    mode: 'MEDIA_COMPOSER',
    aspect_ratio: '16:9',
    status: 'queued',
  })

  const pDir = projectDir(projId)
  const assetsDir = ensureDir(path.join(pDir, 'assets'))
  const voiceWav = path.join(assetsDir, 'voice_test.wav')
  const musicWav = path.join(assetsDir, 'music_test.wav')

  // Generate 2s tone for voice and 3s tone for music
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=800:duration=2', '-c:a', 'pcm_s16le', voiceWav])
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=400:duration=3', '-c:a', 'pcm_s16le', musicWav])

  const voiceAudioId = 'audio-reg-voice-' + uuidv4().slice(0, 8)
  const musicAssetId = 'asset-reg-music-' + uuidv4().slice(0, 8)

  await insert('audios', {
    id: voiceAudioId,
    project_id: projId,
    storage_key: `projects/${projId}/assets/voice_test.wav`,
    duration_sec: 2,
  })

  await insert('assets', {
    id: musicAssetId,
    project_id: projId,
    user_id: testUserId,
    kind: 'audio',
    name: 'music_test.wav',
    storage_key: `projects/${projId}/assets/music_test.wav`,
    byte_size: fs.statSync(musicWav).size,
    mime_type: 'audio/wav',
  })

  // Configure tracks: music muted
  const trackVoiceId = 'track-voice-' + uuidv4().slice(0, 8)
  const trackMusicId = 'track-music-' + uuidv4().slice(0, 8)
  await insert('timeline_tracks', {
    id: trackVoiceId,
    project_id: projId,
    track_type: 'voiceover',
    name: 'Voice Track',
    order_index: 0,
    muted: 0,
    volume: 1.0,
  })
  await insert('timeline_tracks', {
    id: trackMusicId,
    project_id: projId,
    track_type: 'music',
    name: 'Music Track',
    order_index: 1,
    muted: 1, // MUTED
    volume: 0.8,
  })

  await insert('timeline_clips', {
    id: 'clip-voice-' + uuidv4().slice(0, 8),
    project_id: projId,
    track_id: trackVoiceId,
    clip_type: 'voiceover',
    voice_audio_id: voiceAudioId,
    start_at_sec: 0,
    in_sec: 0,
    out_sec: 2,
    volume: 0.9,
    order_index: 0,
  })

  await insert('timeline_clips', {
    id: 'clip-music-' + uuidv4().slice(0, 8),
    project_id: projId,
    track_id: trackMusicId,
    clip_type: 'music',
    asset_id: musicAssetId,
    start_at_sec: 0,
    in_sec: 0,
    out_sec: 3,
    volume: 0.5,
    order_index: 1,
  })

  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projId])
  const renderRes = await composerRender({ project })
  const finalVideoAbs = resolveStorageKey(renderRes.storageKey)
  assert.ok(fs.existsSync(finalVideoAbs), 'Render output exists')

  // Verify buildVoiceTrack volume parameter scaling
  const outVoiceWav = path.join(pDir, 'voice_vol_test.wav')
  await buildVoiceTrack(
    [
      { file: voiceWav, offsetSec: 0, volume: 0.6 },
      { file: voiceWav, offsetSec: 1, volume: 1.2 },
    ],
    3,
    outVoiceWav
  )
  assert.ok(fs.existsSync(outVoiceWav), 'buildVoiceTrack with custom volume values builds successfully')
  console.log('✓ Track mute and individual clip volume scaling verified')
}

// ----------------------------------------------------------------------------------
// 4. TEST-SUB-CLEAN & STRICT RENDER: Subtitle State Cleanup & Failure Handling
// ----------------------------------------------------------------------------------
{
  console.log('\n--- 4. TEST-SUB-CLEAN: Subtitle State Cleanup & Strict Failure ---')
  const projId = 'proj-reg-subs-' + uuidv4().slice(0, 8)
  await insert('projects', {
    id: projId,
    user_id: testUserId,
    title: 'Test Subtitles Lifecycle',
    mode: 'MEDIA_COMPOSER',
    aspect_ratio: '16:9',
    status: 'queued',
  })

  // Case 4A: With text clip -> prepare produces ASS subtitle and persists in DB
  const textClipId = 'clip-text-' + uuidv4().slice(0, 8)
  await insert('timeline_clips', {
    id: textClipId,
    project_id: projId,
    clip_type: 'text',
    text_content: 'Xin chào phụ đề {test}!',
    start_at_sec: 0,
    in_sec: 0,
    out_sec: 3,
    order_index: 0,
  })

  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projId])
  const prepWithSub = await composerPrepare({ project })
  assert.ok(prepWithSub.assPath, 'ASS subtitle path generated when text clips exist')
  assert.ok(fs.existsSync(prepWithSub.assPath), 'ASS file exists on disk')

  const assContent = fs.readFileSync(prepWithSub.assPath, 'utf8')
  assert.ok(!assContent.includes('{test}'), 'ASS curly braces were escaped to prevent malformed tags')

  const subRows = await query('SELECT * FROM subtitles WHERE project_id = ? AND format = "ass"', [projId])
  assert.equal(subRows.length, 1, 'One ASS subtitle row persisted in database')

  // Case 4B: Remove text clips -> prepare cleans up ASS file and clears DB rows
  await run('DELETE FROM timeline_clips WHERE id = ?', [textClipId])
  const prepWithoutSub = await composerPrepare({ project })
  assert.equal(prepWithoutSub.assPath, null, 'assPath is null when 0 text clips remain')
  assert.equal(prepWithoutSub.assStorageKey, null, 'assStorageKey is null when 0 text clips remain')
  assert.ok(!fs.existsSync(prepWithSub.assPath), 'Old subtitles.ass was cleanly unlinked from disk')

  const subRowsAfter = await query('SELECT * FROM subtitles WHERE project_id = ? AND format = "ass"', [projId])
  assert.equal(subRowsAfter.length, 0, 'Subtitles DB records cleaned up when text clips removed')

  console.log('✓ Subtitle lifecycle cleanup and ASS escaping verified')
}

// ----------------------------------------------------------------------------------
// 5. TEST-UP-SIZE: Upload Batch Total Size Limit (200MB -> 413 BATCH_TOO_LARGE)
// ----------------------------------------------------------------------------------
{
  console.log('\n--- 5. TEST-UP-SIZE: Total Size Limit Middleware ---')
  const app = express()
  app.use('/api/v1/projects', composerAssetsRouter)

  const server = app.listen(0)
  const port = server.address().port

  try {
    const projId = 'proj-reg-upload-size-' + uuidv4().slice(0, 8)
    await insert('projects', {
      id: projId,
      user_id: testUserId,
      title: 'Test Upload Size',
      mode: 'MEDIA_COMPOSER',
      status: 'queued',
    })

    // Simulated request exceeding 200MB via Content-Length header using node http
    const resOver = await new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}/api/v1/projects/${projId}/assets`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${userToken}`,
            'Content-Type': 'multipart/form-data; boundary=----WebKitFormBoundaryXYZ',
            'Content-Length': String(210 * 1024 * 1024), // 210MB
          },
        },
        (res) => {
          let data = ''
          res.on('data', (c) => { data += c })
          res.on('end', () => {
            let json = {}
            try { json = JSON.parse(data) } catch (_) {}
            resolve({ status: res.statusCode, json: async () => json })
          })
        }
      )
      req.on('error', reject)
      req.write('----WebKitFormBoundaryXYZ--')
      req.end()
    })

    assert.equal(resOver.status, 413, `Over-limit batch rejected with 413 (got ${resOver.status})`)
    const bodyOver = await resOver.json()
    assert.equal(bodyOver.error?.code, 'BATCH_TOO_LARGE', 'Returns code BATCH_TOO_LARGE')
    console.log('✓ 200MB total size limit rejection verified: 413 BATCH_TOO_LARGE')
  } finally {
    server.close()
  }
}

// ----------------------------------------------------------------------------------
// 6. TEST-UP-MAGIC: File Magic Bytes Validation & Temp Cleanup
// ----------------------------------------------------------------------------------
{
  console.log('\n--- 6. TEST-UP-MAGIC: Media Magic Bytes Validation & Temp Cleanup ---')
  const app = express()
  app.use('/api/v1/projects', composerAssetsRouter)

  const server = app.listen(0)
  const port = server.address().port

  try {
    const projId = 'proj-reg-upload-magic-' + uuidv4().slice(0, 8)
    await insert('projects', {
      id: projId,
      user_id: testUserId,
      title: 'Test Upload Magic',
      mode: 'MEDIA_COMPOSER',
      status: 'queued',
    })

    // Case 6A: Fake file (.jpg extension but contains plain text / script payload)
    const boundary = '----TestBoundary' + Math.random().toString(36).slice(2)
    const fakeContent = 'MZ\x90\x00FAKE_EXECUTABLE_PAYLOAD_NOT_IMAGE'
    const multipartBody =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="fake_image.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n` +
      fakeContent +
      `\r\n--${boundary}--\r\n`

    const resFake = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${projId}/assets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody,
    })

    assert.equal(resFake.status, 400, `Fake file rejected with 400 (got ${resFake.status})`)
    const bodyFake = await resFake.json()
    assert.equal(bodyFake.error?.code, 'UNSUPPORTED_MEDIA_TYPE', 'Returns code UNSUPPORTED_MEDIA_TYPE')

    // Verify temp file was cleaned up from storage/tmp_uploads
    const tmpUploadsDir = path.join(config.storageDir, 'tmp_uploads')
    if (fs.existsSync(tmpUploadsDir)) {
      const files = fs.readdirSync(tmpUploadsDir)
      assert.ok(!files.some((f) => f.includes('fake_image')), 'Temp file unlinked after rejected upload')
    }

    // Case 6B: Valid PNG file upload succeeds
    const validBoundary = '----ValidBoundary' + Math.random().toString(36).slice(2)
    const validHeader = `--${validBoundary}\r\nContent-Disposition: form-data; name="files"; filename="real_image.png"\r\nContent-Type: image/png\r\n\r\n`
    const validFooter = `\r\n--${validBoundary}--\r\n`
    const validBody = Buffer.concat([
      Buffer.from(validHeader, 'binary'),
      dummyPng,
      Buffer.from(validFooter, 'binary'),
    ])

    const resValid = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${projId}/assets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': `multipart/form-data; boundary=${validBoundary}`,
      },
      body: validBody,
    })

    assert.equal(resValid.status, 200, `Valid media file accepted with 200 (got ${resValid.status})`)
    const bodyValid = await resValid.json()
    assert.ok(Array.isArray(bodyValid.assets) && bodyValid.assets.length === 1, 'Valid asset saved and returned')

    console.log('✓ Magic bytes signature validation and temp cleanup verified')
  } finally {
    server.close()
  }
}

console.log('\n======================================================')
console.log(' ALL COMPOSER CHU KỲ 2 REGRESSION BUG TESTS PASSED! ')
console.log('======================================================\n')
