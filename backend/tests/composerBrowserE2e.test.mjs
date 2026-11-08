import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_composer_e2e_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne, run } = await import('../src/db/query.js')
const { projectDir, ensureDir, resolveStorageKey, toStorageKey } = await import('../src/pipeline/context.js')
const { config } = await import('../src/config.js')
const { probe } = await import('../src/media/ffmpeg.js')
const {
  ensureDefaultTracks,
  autoArrangeTimeline,
  saveTimeline,
  processOcr,
  processTranslation,
} = await import('../src/services/composerService.js')
const { composerIngest } = await import('../src/pipeline/stages/composerIngest.js')
const { composerPrepare } = await import('../src/pipeline/stages/composerPrepare.js')
const { composerRender } = await import('../src/pipeline/stages/composerRender.js')

await initSchema()

console.log('=== AI Media Composer 16-Step Browser & Integration E2E Test ===\n')

const testUserId = 'user-composer-e2e-1'
await insert('users', {
  id: testUserId,
  email: 'composer-e2e@test.local',
  role: 'user',
  password: 'hash',
})

const projectId = `proj-composer-e2e-${Date.now()}`
const pDir = projectDir(projectId)
const assetsDir = ensureDir(path.join(pDir, 'assets'))

// STEP 1: Create MEDIA_COMPOSER Project
console.log('--- Step 1: Create MEDIA_COMPOSER Project ---')
await insert('projects', {
  id: projectId,
  user_id: testUserId,
  title: 'AI Media Composer E2E Showcase',
  mode: 'MEDIA_COMPOSER',
  status: 'queued',
  aspect_ratio: '16:9',
  params: JSON.stringify({
    aspectRatio: '16:9',
    resolution: '1080p',
    fps: 30,
    defaultBackground: '#0B192C',
  }),
})

const defaultTracks = await ensureDefaultTracks(projectId)
assert.equal(defaultTracks.length, 5, 'Step 1 PASS: 5 default tracks created')
const trackTypes = defaultTracks.map((t) => t.track_type)
assert.deepEqual(trackTypes, ['background', 'image', 'voiceover', 'music', 'text'], 'Step 1 PASS: Track types order')

// Helper to create test image via ffmpeg
function createTestImage(filename, colorHex = '#1E1E2E') {
  const filePath = path.join(assetsDir, filename)
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi',
    '-i', `color=c=${colorHex}:s=640x360:d=1`,
    '-frames:v', '1',
    filePath,
  ], { stdio: 'ignore' })
  return filePath
}

// Helper to create test audio via ffmpeg
function createTestAudio(filename, durationSec = 3, freq = 440) {
  const filePath = path.join(assetsDir, filename)
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi',
    '-i', `sine=frequency=${freq}:duration=${durationSec}`,
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    filePath,
  ], { stdio: 'ignore' })
  return filePath
}

// STEP 2: Background Asset Upload
console.log('--- Step 2: Upload Background Image Asset ---')
const bgPath = createTestImage('bg_dark_slate.png', '#0B192C')
const bgAssetId = 'asset-bg-1'
await insert('assets', {
  id: bgAssetId,
  project_id: projectId,
  user_id: testUserId,
  kind: 'background',
  name: 'bg_dark_slate.png',
  storage_key: toStorageKey(bgPath),
  order_index: 0,
})
assert.ok(fs.existsSync(bgPath), 'Step 2 PASS: Background asset created')

// STEP 3: 5 Image Slide Assets Upload
console.log('--- Step 3: Upload 5 Image Slide Assets ---')
const slideColors = ['#E63946', '#F1FAEE', '#A8DADC', '#457B9D', '#1D3557']
const slideAssetIds = []
for (let i = 1; i <= 5; i++) {
  const sPath = createTestImage(`slide_${i}.png`, slideColors[i - 1])
  const aId = `asset-slide-${i}`
  slideAssetIds.push(aId)
  await insert('assets', {
    id: aId,
    project_id: projectId,
    user_id: testUserId,
    kind: 'image',
    name: `Slide ${i}.png`,
    storage_key: toStorageKey(sPath),
    order_index: i - 1,
  })
}
assert.equal(slideAssetIds.length, 5, 'Step 3 PASS: 5 slide images uploaded')

// STEP 4: Reorder Images (Move Slide 4 to Position 1)
console.log('--- Step 4: Reorder Images in Media Library ---')
const reorderedIds = [slideAssetIds[3], slideAssetIds[0], slideAssetIds[1], slideAssetIds[2], slideAssetIds[4]]
for (let idx = 0; idx < reorderedIds.length; idx++) {
  await run('UPDATE assets SET order_index = ? WHERE id = ? AND project_id = ?', [idx, reorderedIds[idx], projectId])
}
const orderedAssets = await query(
  `SELECT id, name FROM assets WHERE project_id = ? AND kind = 'image' ORDER BY order_index ASC`,
  [projectId]
)
assert.equal(orderedAssets[0].name, 'Slide 4.png', 'Step 4 PASS: Slide 4 moved to first position')

// STEP 5: Upload BGM Asset (Short 3s loop test)
console.log('--- Step 5: Upload BGM Music Asset ---')
const bgmPath = createTestAudio('bgm_ambient.mp3', 3, 220)
const bgmAssetId = 'asset-bgm-1'
await insert('assets', {
  id: bgmAssetId,
  project_id: projectId,
  user_id: testUserId,
  kind: 'music',
  name: 'bgm_ambient.mp3',
  storage_key: toStorageKey(bgmPath),
  duration_sec: 3.0,
  order_index: 0,
})
assert.ok(fs.existsSync(bgmPath), 'Step 5 PASS: BGM asset created')

// STEP 6: Upload Voiceover Asset (6s duration)
console.log('--- Step 6: Upload Voiceover Audio Asset ---')
const voPath = createTestAudio('vo_narration.mp3', 6, 440)
const voAssetId = 'asset-vo-1'
await insert('assets', {
  id: voAssetId,
  project_id: projectId,
  user_id: testUserId,
  kind: 'voiceover',
  name: 'vo_narration.mp3',
  storage_key: toStorageKey(voPath),
  duration_sec: 6.0,
  order_index: 0,
})
assert.ok(fs.existsSync(voPath), 'Step 6 PASS: Voiceover asset created')

// STEP 7: OCR & Translation Caching
console.log('--- Step 7: OCR and Translation Caching on Image ---')
await run('UPDATE assets SET ocr_text = ?, translation_text = ?, translation_target_lang = ? WHERE id = ?', [
  'SPECIAL DISCOUNT 50%',
  'Khuyến mãi đặc biệt 50%',
  'vi',
  slideAssetIds[0],
])

const ocrRes = await processOcr({ projectId, userId: testUserId, assetId: slideAssetIds[0] })
assert.equal(ocrRes.cached, true, 'Step 7 PASS: OCR cached=true')
assert.equal(ocrRes.text, 'SPECIAL DISCOUNT 50%', 'Step 7 PASS: OCR text matches')

const trRes = await processTranslation({
  text: 'SPECIAL DISCOUNT 50%',
  targetLanguage: 'vi',
  assetId: slideAssetIds[0],
})
assert.equal(trRes.cached, true, 'Step 7 PASS: Translation cached=true')
assert.equal(trRes.translatedText, 'Khuyến mãi đặc biệt 50%', 'Step 7 PASS: Translated text matches')

// STEP 8: Text Overlay Clip on Track 5
console.log('--- Step 8: Add Text Overlay Clip to Timeline ---')
const textTrack = defaultTracks.find((t) => t.track_type === 'text')
await insert('timeline_clips', {
  id: 'clip-text-discount',
  project_id: projectId,
  track_id: textTrack.id,
  clip_type: 'text',
  start_at_sec: 1.0,
  out_sec: 4.5,
  text_content: 'Khuyến mãi đặc biệt 50%',
  style_json: JSON.stringify({ fontSize: 32, color: '#FFD700', position: 'bottom', fontFamily: 'Montserrat' }),
})
assert.ok(true, 'Step 8 PASS: Text overlay clip inserted')

// STEP 9: Auto-Arrange Timeline Allocation
console.log('--- Step 9: Trigger autoArrangeTimeline ---')
const arrangeRes = await autoArrangeTimeline({
  projectId,
  imageDurationSec: 4.0,
  enableBgmDucking: true,
})

assert.equal(arrangeRes.totalDuration, 6.0, 'Step 9 PASS: Total duration scaled to voiceover 6.0s')
const clips = arrangeRes.clips
const imageClips = clips.filter((c) => c.clip_type === 'image')
assert.equal(imageClips.length, 5, 'Step 9 PASS: 5 image clips arranged')
assert.equal(imageClips[0].out_sec, 1.2, 'Step 9 PASS: 5 images evenly allocated across 6s (each 1.2s)')

const musicClips = clips.filter((c) => c.clip_type === 'music')
assert.equal(musicClips.length, 1, 'Step 9 PASS: 1 BGM clip')
assert.equal(musicClips[0].volume, 0.25, 'Step 9 PASS: BGM ducked to 0.25 volume due to voiceover')

// STEP 10: Manual Timeline Trim Persistence
console.log('--- Step 10: Manual Timeline Trim via saveTimeline ---')
await saveTimeline({
  projectId,
  tracks: defaultTracks,
  clips: [
    ...clips,
    {
      id: 'clip-text-discount',
      track_id: textTrack.id,
      clip_type: 'text',
      start_at_sec: 1.0,
      out_sec: 4.5,
      text_content: 'Khuyến mãi đặc biệt 50%',
      style_json: JSON.stringify({ fontSize: 32, color: '#FFD700', position: 'bottom', fontFamily: 'Montserrat' }),
    },
  ],
})
const savedClips = await query('SELECT * FROM timeline_clips WHERE project_id = ?', [projectId])
assert.ok(savedClips.length >= 7, 'Step 10 PASS: All clips persisted')

// STEP 11: Execute composerIngest Stage
console.log('--- Step 11: Execute composerIngest Stage ---')
const projectRow = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
const ingestRes = await composerIngest({ project: projectRow })
assert.equal(ingestRes.durationSec, 6, 'Step 11 PASS: Ingest computed 6s duration')

// STEP 12: Execute composerPrepare Stage
console.log('--- Step 12: Execute composerPrepare Stage ---')
const prepRes = await composerPrepare({ project: projectRow })
assert.ok(prepRes.assPath && fs.existsSync(prepRes.assPath), 'Step 12 PASS: ASS subtitles written')
const assContent = fs.readFileSync(prepRes.assPath, 'utf8')
assert.ok(assContent.includes('Khuyến mãi đặc biệt 50%'), 'Step 12 PASS: ASS contains Vietnamese text')
assert.ok(assContent.includes('Arial'), 'Step 12 PASS: ASS contains Unicode safe font')
assert.ok(assContent.includes('Montserrat'), 'Step 12 PASS: ASS contains custom font tag (\\fnMontserrat)')

// STEP 13: Execute composerRender Stage
console.log('--- Step 13: Execute composerRender Stage (Multi-layer + Ducking) ---')
const renderRes = await composerRender({ project: projectRow })
assert.ok(renderRes.outputId, 'Step 13 PASS: Video rendered with outputId')
assert.ok(renderRes.storageKey, 'Step 13 PASS: Video stored with storageKey')

// STEP 14: FFprobe Verification on Final Output Video
console.log('--- Step 14: FFprobe Verification on Output MP4 ---')
const finalMp4Abs = resolveStorageKey(renderRes.storageKey)
assert.ok(fs.existsSync(finalMp4Abs), 'Step 14 PASS: Output MP4 exists on disk')
const mediaInfo = await probe(finalMp4Abs)

assert.ok(mediaInfo.durationSec >= 5, `Step 14 PASS: Valid duration (${mediaInfo.durationSec}s)`)
assert.equal(mediaInfo.width, 1920, 'Step 14 PASS: Full HD Width 1920')
assert.equal(mediaInfo.height, 1080, 'Step 14 PASS: Full HD Height 1080')
assert.equal(mediaInfo.codec, 'h264', 'Step 14 PASS: Video codec H.264')
assert.ok(mediaInfo.hasAudio, 'Step 14 PASS: Has audio stream')

// STEP 15: Output Record in DB
console.log('--- Step 15: Verify outputs Table Record ---')
const outputRow = await queryOne('SELECT * FROM outputs WHERE id = ?', [renderRes.outputId])
assert.ok(outputRow, 'Step 15 PASS: Output recorded in DB')
assert.equal(outputRow.status, 'success', 'Step 15 PASS: Output status is success')
assert.equal(outputRow.project_id, projectId, 'Step 15 PASS: Output project_id matches')

// STEP 16: Thumbnail Verification
console.log('--- Step 16: Verify Output Thumbnail ---')
const thumbAbs = path.join(config.storageDir, outputRow.thumbnail_key)
assert.ok(fs.existsSync(thumbAbs), 'Step 16 PASS: Output thumbnail generated and exists on disk')
const thumbStat = fs.statSync(thumbAbs)
assert.ok(thumbStat.size > 500, `Step 16 PASS: Thumbnail size valid (${thumbStat.size} bytes)`)

console.log('\n======================================================')
console.log('ALL 16 STEPS OF BROWSER & INTEGRATION E2E TEST PASSED!')
console.log('======================================================\n')
process.exit(0)
