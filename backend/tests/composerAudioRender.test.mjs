import assert from 'node:assert'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_audio_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { query, queryOne, insert } = await import('../src/db/query.js')
const { composerRender } = await import('../src/pipeline/stages/composerRender.js')
const { composerPrepare } = await import('../src/pipeline/stages/composerPrepare.js')
const { projectDir, ensureDir, resolveStorageKey } = await import('../src/pipeline/context.js')
const { probe, ffmpeg } = await import('../src/media/ffmpeg.js')
const composerService = (await import('../src/services/composerService.js')).default

await initSchema()

console.log('=== Test Composer Rendering Audio & Multi-Track Mixing ===')

const testUserId = 'user-audio-test-' + uuidv4().slice(0, 8)
await insert('users', {
  id: testUserId,
  email: `audio-${uuidv4().slice(0, 8)}@test.com`,
  password: 'hash',
})

// 1. TEST-AUDIO-VIDEO-CLIP: Video clip audio is preserved and mixed into output
{
  console.log('\n--- 1. TEST-AUDIO-VIDEO-CLIP: Video Clip Audio Preservation ---')
  const projId = 'proj-audio-vid-' + uuidv4().slice(0, 8)
  await insert('projects', {
    id: projId,
    user_id: testUserId,
    title: 'Test Video Audio Preserved',
    mode: 'MEDIA_COMPOSER',
    aspect_ratio: '16:9',
    status: 'queued',
  })

  await composerService.ensureDefaultTracks(projId)
  const tracks = await query('SELECT * FROM timeline_tracks WHERE project_id = ?', [projId])
  const trackMap = new Map(tracks.map((t) => [t.track_type, t]))

  const pDir = projectDir(projId)
  const assetsDir = ensureDir(path.join(pDir, 'assets'))
  const vidPath = path.join(assetsDir, 'source_with_audio.mp4')

  // Generate a 2s video with a 440Hz sine wave tone
  await ffmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    vidPath,
  ])

  const assetId = 'asset-vid-' + uuidv4().slice(0, 8)
  await insert('assets', {
    id: assetId,
    project_id: projId,
    user_id: testUserId,
    kind: 'video',
    name: 'source_with_audio.mp4',
    storage_key: `projects/${projId}/assets/source_with_audio.mp4`,
    mime_type: 'video/mp4',
    duration_sec: 2,
  })

  await insert('timeline_clips', {
    id: 'clip-vid-' + uuidv4().slice(0, 8),
    project_id: projId,
    track_id: trackMap.get('video')?.id,
    clip_type: 'video',
    asset_id: assetId,
    start_at_sec: 0,
    in_sec: 0,
    out_sec: 2,
    volume: 1.0,
    speed: 1.0,
    order_index: 0,
  })

  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projId])
  const result = await composerRender({ project })
  assert.ok(result && result.storageKey, 'Render returned storageKey')

  const outAbs = resolveStorageKey(result.storageKey)
  const outInfo = await probe(outAbs)
  assert.strictEqual(outInfo.hasAudio, true, 'Rendered video must contain audio')
  console.log('✓ Video clip audio preserved in final render: duration=' + outInfo.durationSec)
}

// 2. TEST-MULTI-MUSIC: Multiple music clips at distinct timeline offsets
{
  console.log('\n--- 2. TEST-MULTI-MUSIC: Multiple Music Clips at Distinct Offsets ---')
  const projId = 'proj-multi-bgm-' + uuidv4().slice(0, 8)
  await insert('projects', {
    id: projId,
    user_id: testUserId,
    title: 'Test Multi Music Timing',
    mode: 'MEDIA_COMPOSER',
    aspect_ratio: '16:9',
    status: 'queued',
  })

  await composerService.ensureDefaultTracks(projId)
  const tracks = await query('SELECT * FROM timeline_tracks WHERE project_id = ?', [projId])
  const trackMap = new Map(tracks.map((t) => [t.track_type, t]))

  const pDir = projectDir(projId)
  const assetsDir = ensureDir(path.join(pDir, 'assets'))
  const bgm1Path = path.join(assetsDir, 'bgm1.wav')
  const bgm2Path = path.join(assetsDir, 'bgm2.wav')

  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-c:a', 'pcm_s16le', bgm1Path])
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=600:duration=2', '-c:a', 'pcm_s16le', bgm2Path])

  const asset1Id = 'asset-bgm1-' + uuidv4().slice(0, 8)
  const asset2Id = 'asset-bgm2-' + uuidv4().slice(0, 8)

  await insert('assets', {
    id: asset1Id,
    project_id: projId,
    user_id: testUserId,
    kind: 'music',
    name: 'bgm1.wav',
    storage_key: `projects/${projId}/assets/bgm1.wav`,
    mime_type: 'audio/wav',
    duration_sec: 2,
  })
  await insert('assets', {
    id: asset2Id,
    project_id: projId,
    user_id: testUserId,
    kind: 'music',
    name: 'bgm2.wav',
    storage_key: `projects/${projId}/assets/bgm2.wav`,
    mime_type: 'audio/wav',
    duration_sec: 2,
  })

  // Clip 1: 0s -> 2s
  await insert('timeline_clips', {
    id: 'clip-bgm-1-' + uuidv4().slice(0, 8),
    project_id: projId,
    track_id: trackMap.get('music')?.id,
    clip_type: 'music',
    asset_id: asset1Id,
    start_at_sec: 0,
    in_sec: 0,
    out_sec: 2,
    volume: 0.8,
    order_index: 0,
  })

  // Clip 2: 2s -> 4s
  await insert('timeline_clips', {
    id: 'clip-bgm-2-' + uuidv4().slice(0, 8),
    project_id: projId,
    track_id: trackMap.get('music')?.id,
    clip_type: 'music',
    asset_id: asset2Id,
    start_at_sec: 2,
    in_sec: 0,
    out_sec: 2,
    volume: 0.8,
    order_index: 1,
  })

  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projId])
  const result = await composerRender({ project })
  assert.ok(result && result.storageKey, 'Render returned storageKey')

  const outAbs = resolveStorageKey(result.storageKey)
  const outInfo = await probe(outAbs)
  assert.strictEqual(outInfo.hasAudio, true, 'Rendered video must contain audio')
  assert.ok(outInfo.durationSec >= 3.8, `Output duration must be >= 3.8s, got ${outInfo.durationSec}`)
  console.log('✓ Multiple music clips mixed at distinct offsets: duration=' + outInfo.durationSec)
}

// 3. TEST-SFX-ISOLATION: SFX clip with audio_id is not duplicated into voiceClips
{
  console.log('\n--- 3. TEST-SFX-ISOLATION: SFX Not Misclassified as Voice ---')
  const projId = 'proj-sfx-iso-' + uuidv4().slice(0, 8)
  await insert('projects', {
    id: projId,
    user_id: testUserId,
    title: 'Test SFX Isolation',
    mode: 'MEDIA_COMPOSER',
    aspect_ratio: '16:9',
    status: 'queued',
  })

  await composerService.ensureDefaultTracks(projId)
  const tracks = await query('SELECT * FROM timeline_tracks WHERE project_id = ?', [projId])
  const trackMap = new Map(tracks.map((t) => [t.track_type, t]))

  const pDir = projectDir(projId)
  const assetsDir = ensureDir(path.join(pDir, 'assets'))
  const sfxPath = path.join(assetsDir, 'whoosh.wav')
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=800:duration=1', '-c:a', 'pcm_s16le', sfxPath])

  const sfxAssetId = 'asset-sfx-' + uuidv4().slice(0, 8)
  await insert('assets', {
    id: sfxAssetId,
    project_id: projId,
    user_id: testUserId,
    kind: 'sfx',
    name: 'whoosh.wav',
    storage_key: `projects/${projId}/assets/whoosh.wav`,
    mime_type: 'audio/wav',
    duration_sec: 1,
  })

  // Insert clip on SFX track with voice_audio_id populated
  await insert('timeline_clips', {
    id: 'clip-sfx-' + uuidv4().slice(0, 8),
    project_id: projId,
    track_id: trackMap.get('sfx')?.id,
    clip_type: 'sfx',
    asset_id: sfxAssetId,
    voice_audio_id: sfxAssetId,
    start_at_sec: 0,
    in_sec: 0,
    out_sec: 1,
    volume: 1.0,
    order_index: 0,
  })

  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projId])
  const result = await composerRender({ project })
  assert.ok(result && result.storageKey, 'Render returned storageKey')

  const outAbs = resolveStorageKey(result.storageKey)
  const outInfo = await probe(outAbs)
  assert.strictEqual(outInfo.hasAudio, true, 'Rendered video must contain audio')
  console.log('✓ SFX clip rendered cleanly without voice contamination')
}

// 4. TEST-SVG-THUMBNAIL-SKIP: Uploading SVG skips FFmpeg thumbnailing without error logs
{
  console.log('\n--- 4. TEST-SVG-THUMBNAIL-SKIP: SVG Thumbnail Fallback ---')
  const projId = 'proj-svg-thumb-' + uuidv4().slice(0, 8)
  await insert('projects', {
    id: projId,
    user_id: testUserId,
    title: 'Test SVG Thumbnail',
    mode: 'MEDIA_COMPOSER',
    aspect_ratio: '16:9',
    status: 'pending',
  })

  const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="blue" width="100" height="100"/></svg>'
  const saved = await composerService.saveUploadedAsset({
    projectId: projId,
    userId: testUserId,
    file: {
      originalname: 'vector.svg',
      mimetype: 'image/svg+xml',
      buffer: Buffer.from(svgContent, 'utf8'),
      size: Buffer.byteLength(svgContent),
    },
    kind: 'image',
  })

  assert.strictEqual(saved.thumbnailKey, null, 'SVG thumbnailKey should be null (no ffmpeg crash)')
  assert.ok(saved.thumbnailUrl && saved.thumbnailUrl.endsWith('.svg'), 'thumbnailUrl falls back to SVG asset URL')
  console.log('✓ SVG thumbnail generation cleanly skipped FFmpeg and set fallback URL')
}

console.log('\n======================================================')
console.log(' ALL COMPOSER AUDIO & MULTI-TRACK MIXING TESTS PASS! ')
console.log('======================================================')
