import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import crypto from 'node:crypto'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_composer_assets_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne, run } = await import('../src/db/query.js')
const { projectDir, ensureDir } = await import('../src/pipeline/context.js')
const {
  processOcr,
  processTranslation,
  saveTimeline,
  ensureDefaultTracks,
} = await import('../src/services/composerService.js')
const { MockVision } = await import('../src/providers/vision/mockVision.js')
const { GoogleTranslate } = await import('../src/providers/translate/googleTranslate.js')

await initSchema()

console.log('=== AI Media Composer Assets & OCR/Translation Caching Tests ===\n')

const testUserId = 'user-composer-asset-1'
await insert('users', {
  id: testUserId,
  email: 'composer-asset@test.local',
  role: 'user',
  password: 'hash',
})

const projectId = 'proj-asset-1'
await insert('projects', {
  id: projectId,
  user_id: testUserId,
  title: 'Test Composer Assets',
  mode: 'MEDIA_COMPOSER',
  status: 'queued',
})

// Create test image file in project directory
const pDir = projectDir(projectId)
const assetsDir = ensureDir(path.join(pDir, 'assets'))
const imgPath = path.join(assetsDir, 'test_ocr_slide.png')
const dummyPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])
fs.writeFileSync(imgPath, dummyPng)

const assetId = 'asset-test-ocr-1'
await insert('assets', {
  id: assetId,
  project_id: projectId,
  user_id: testUserId,
  kind: 'image',
  name: 'test_ocr_slide.png',
  storage_key: `projects/${projectId}/assets/test_ocr_slide.png`,
  order_index: 0,
})

// 1. OCR Asset-level Caching Test
{
  console.log('--- 1. OCR Asset-level Caching ---')
  await run('UPDATE assets SET ocr_text = ?, ocr_data = ? WHERE id = ?', [
    'Trí tuệ nhân tạo thế hệ mới',
    JSON.stringify([{ text: 'Trí tuệ nhân tạo', confidence: 0.95 }]),
    assetId,
  ])

  const ocrRes = await processOcr({
    projectId,
    userId: testUserId,
    assetId,
  })

  assert.equal(ocrRes.cached, true, 'Returns cached=true from asset')
  assert.equal(ocrRes.text, 'Trí tuệ nhân tạo thế hệ mới', 'Returns cached text exactly')
  assert.equal(ocrRes.boxes.length, 1, 'Parses ocr_data boxes')
}

// 2. OCR Provider-cache level Test
{
  console.log('--- 2. OCR Provider-cache level hit ---')
  const assetId2 = 'asset-test-ocr-2'
  const imgPath2 = path.join(assetsDir, 'test_ocr_slide_2.png')
  const contentBytes = Buffer.from('dummy-image-bytes-for-hash-test')
  fs.writeFileSync(imgPath2, contentBytes)

  await insert('assets', {
    id: assetId2,
    project_id: projectId,
    user_id: testUserId,
    kind: 'image',
    name: 'test_ocr_slide_2.png',
    storage_key: `projects/${projectId}/assets/test_ocr_slide_2.png`,
    order_index: 1,
  })

  const hash = crypto.createHash('sha256').update(contentBytes).digest('hex')
  await insert('provider_cache', {
    id: 'cache-ocr-test-1',
    provider: 'vision',
    type: 'ocr',
    input_hash: hash,
    result: JSON.stringify({
      text: 'Tiêu đề trích xuất từ Provider Cache',
      boxes: [{ text: 'Tiêu đề', confidence: 0.99 }],
    }),
  })

  const ocrRes2 = await processOcr({
    projectId,
    userId: testUserId,
    assetId: assetId2,
  })

  assert.equal(ocrRes2.cached, true, 'Returns cached=true from provider_cache')
  assert.equal(ocrRes2.text, 'Tiêu đề trích xuất từ Provider Cache', 'Matches provider cache content')

  // Verify DB asset was updated
  const updatedAsset = await queryOne('SELECT * FROM assets WHERE id = ?', [assetId2])
  assert.equal(updatedAsset.ocr_text, 'Tiêu đề trích xuất từ Provider Cache', 'Asset ocr_text was populated')
}

// 3. Translation Asset-level Caching Test
{
  console.log('--- 3. Translation Asset-level Caching ---')
  await run(
    'UPDATE assets SET translation_text = ?, translation_target_lang = ? WHERE id = ?',
    ['Generative Artificial Intelligence', 'en', assetId]
  )

  const trRes1 = await processTranslation({
    text: 'Trí tuệ nhân tạo thế hệ mới',
    targetLanguage: 'en',
    assetId,
  })

  assert.equal(trRes1.cached, true, 'Returns cached=true for matching language')
  assert.equal(trRes1.translatedText, 'Generative Artificial Intelligence', 'Returns translation text')
}

// 4. Translation Provider-cache level Test
{
  console.log('--- 4. Translation Provider-cache level hit ---')
  const sourceText = 'Trí tuệ nhân tạo thế hệ mới'
  const trHash = crypto.createHash('sha256').update(`auto:fr:${sourceText}`).digest('hex')

  await insert('provider_cache', {
    id: 'cache-tr-test-1',
    provider: 'translate',
    type: 'text',
    input_hash: trHash,
    result: JSON.stringify({
      translatedText: "L'intelligence artificielle de nouvelle génération",
    }),
  })

  const trResFr = await processTranslation({
    text: sourceText,
    targetLanguage: 'fr',
    sourceLanguage: 'auto',
    assetId: 'asset-test-ocr-2',
  })

  assert.equal(trResFr.cached, true, 'Returns cached=true from provider_cache')
  assert.equal(trResFr.translatedText, "L'intelligence artificielle de nouvelle génération", 'Matches French translation')
}

// 5. saveUploadedAsset & File Persistence Test
{
  console.log('--- 5. saveUploadedAsset buffer persistence & metadata ---')
  const { saveUploadedAsset } = await import('../src/services/composerService.js')
  const uploaded = await saveUploadedAsset({
    projectId,
    userId: testUserId,
    file: {
      originalname: 'upload_test.png',
      buffer: dummyPng,
      mimetype: 'image/png',
      size: dummyPng.length,
    },
    kind: 'image',
    orderIndex: 2,
  })

  assert.ok(uploaded.id, 'Asset ID generated')
  assert.equal(uploaded.kind, 'image', 'Asset kind is image')
  assert.equal(uploaded.name, 'upload_test.png', 'Original name preserved')
  assert.equal(uploaded.orderIndex, 2, 'Order index set')
  assert.ok(uploaded.url.startsWith('/storage/'), 'Storage URL generated')

  const dbRow = await queryOne('SELECT * FROM assets WHERE id = ?', [uploaded.id])
  assert.ok(dbRow, 'Asset inserted into database')
  assert.equal(dbRow.byte_size, dummyPng.length, 'Byte size matches')
}

// 6. Delete Asset Cascading Cleanup Test
{
  console.log('--- 6. Asset Deletion & Clip Cascading Cleanup ---')
  const delAssetId = 'asset-delete-test-1'
  await insert('assets', {
    id: delAssetId,
    project_id: projectId,
    user_id: testUserId,
    kind: 'voiceover',
    name: 'vo_to_delete.mp3',
    storage_key: `projects/${projectId}/assets/vo_to_delete.mp3`,
    order_index: 9,
  })
  await insert('audios', {
    id: delAssetId,
    project_id: projectId,
    kind: 'voiceover',
    storage_key: `projects/${projectId}/assets/vo_to_delete.mp3`,
  })
  await insert('timeline_clips', {
    id: 'clip-vo-del-1',
    project_id: projectId,
    clip_type: 'voiceover',
    voice_audio_id: delAssetId,
    asset_id: delAssetId,
  })

  // Execute deletion logic matching composerAssets router
  await run('DELETE FROM assets WHERE id = ?', [delAssetId])
  await run('DELETE FROM audios WHERE id = ?', [delAssetId])
  await run('DELETE FROM timeline_clips WHERE asset_id = ? OR voice_audio_id = ?', [delAssetId, delAssetId])

  const checkAsset = await queryOne('SELECT * FROM assets WHERE id = ?', [delAssetId])
  assert.equal(checkAsset, null, 'Asset was removed from DB')
  const checkClip = await queryOne('SELECT * FROM timeline_clips WHERE id = ?', ['clip-vo-del-1'])
  assert.equal(checkClip, null, 'Referencing timeline clip was removed from DB')
}

// 7. Edge Cases & Boundary Conditions
{
  console.log('--- 7. Edge Cases: invalid inputs & missing assets ---')
  // Missing asset for OCR throws error
  await assert.rejects(
    async () => {
      await processOcr({ projectId, userId: testUserId, assetId: 'non-existent-asset-id' })
    },
    /Asset not found/,
    'processOcr throws on non-existent asset'
  )

  // Empty text for translation throws error
  await assert.rejects(
    async () => {
      await processTranslation({ text: '   ', targetLanguage: 'vi' })
    },
    /Text to translate is required/,
    'processTranslation throws on empty/whitespace text'
  )
}

// 8. BUG 1 Verification: Vision OCR Truthfulness & NO_TEXT vs Failure
{
  console.log('--- 8. BUG 1 Verification: Vision OCR Truthfulness & NO_TEXT Handling ---')
  const origDetect = MockVision.prototype.detectSubtitle

  const cleanAssetId = 'asset-clean-photo-1'
  const cleanImgPath = path.join(assetsDir, 'clean_photo.png')
  fs.writeFileSync(cleanImgPath, dummyPng)

  await insert('assets', {
    id: cleanAssetId,
    project_id: projectId,
    user_id: testUserId,
    kind: 'image',
    name: 'clean_landscape.png',
    storage_key: `projects/${projectId}/assets/clean_photo.png`,
    order_index: 20,
    ocr_text: null,
    ocr_data: null,
  })

  // Case 8A: Vision OCR runs, but detects NO text -> status 'NO_TEXT', text '', NO fake fallback, NO provider_cache
  MockVision.prototype.detectSubtitle = async () => ({ boxes: [] })

  const noTextRes = await processOcr({
    projectId,
    userId: testUserId,
    assetId: cleanAssetId,
    visionProvider: 'mock',
    force: true,
  })

  assert.equal(noTextRes.status, 'NO_TEXT', 'Status is NO_TEXT')
  assert.equal(noTextRes.text, '', 'Text is empty string, no fake placeholder')
  assert.equal(noTextRes.cached, false, 'cached=false')

  const assetRowAfter = await queryOne('SELECT ocr_text, ocr_data FROM assets WHERE id = ?', [cleanAssetId])
  assert.equal(assetRowAfter.ocr_text, '', 'Asset ocr_text is empty, not fake placeholder')

  const fileBytes = fs.readFileSync(cleanImgPath)
  const cleanHash = crypto.createHash('sha256').update(fileBytes).digest('hex')
  const cacheRow = await queryOne('SELECT * FROM provider_cache WHERE input_hash = ?', [cleanHash])
  assert.equal(cacheRow, null, 'No entry cached for empty OCR result')

  // Case 8B: Vision Provider fails -> Throws VISION_OCR_FAILED, no fake text saved
  MockVision.prototype.detectSubtitle = async () => {
    throw new Error('Upstream OCR API 503 Service Unavailable')
  }

  await assert.rejects(
    async () => {
      await processOcr({
        projectId,
        userId: testUserId,
        assetId: cleanAssetId,
        visionProvider: 'mock',
        force: true,
      })
    },
    (err) => err.code === 'VISION_OCR_FAILED',
    'Throws VISION_OCR_FAILED on provider error'
  )

  // Case 8C: Legitimate OCR detection succeeds and caches properly
  MockVision.prototype.detectSubtitle = async () => ({
    boxes: [{ text: 'GIẢM GIÁ 50%', confidence: 0.98 }],
  })

  const successRes = await processOcr({
    projectId,
    userId: testUserId,
    assetId: cleanAssetId,
    visionProvider: 'mock',
    force: true,
  })

  assert.equal(successRes.status, 'SUCCESS', 'Status is SUCCESS')
  assert.equal(successRes.text, 'GIẢM GIÁ 50%', 'Extracts actual detected text')
  assert.equal(successRes.cached, false, 'First run cached=false')

  // Second run hits asset-level cache
  const cachedRes = await processOcr({
    projectId,
    userId: testUserId,
    assetId: cleanAssetId,
    visionProvider: 'mock',
  })
  assert.equal(cachedRes.cached, true, 'Subsequent run hits cache')
  assert.equal(cachedRes.text, 'GIẢM GIÁ 50%', 'Returns cached text')

  // Restore MockVision
  MockVision.prototype.detectSubtitle = origDetect
}

// 9. BUG 2 Verification: Translation Truthfulness & Cache Invalidation
{
  console.log('--- 9. BUG 2 Verification: Translation Truthfulness & Cache Invalidation ---')
  const trAssetId = 'asset-tr-invalidate-1'
  await insert('assets', {
    id: trAssetId,
    project_id: projectId,
    user_id: testUserId,
    kind: 'image',
    name: 'slide_tr.png',
    storage_key: `projects/${projectId}/assets/test_ocr_slide.png`,
    order_index: 30,
    ocr_text: 'Hello World',
    translation_text: 'Xin chào thế giới',
    translation_target_lang: 'vi',
  })

  // Case 9A: When source text matches asset.ocr_text, asset cache is valid
  const hitRes = await processTranslation({
    text: 'Hello World',
    targetLanguage: 'vi',
    assetId: trAssetId,
  })
  assert.equal(hitRes.cached, true, 'Hits asset cache when text matches')
  assert.equal(hitRes.translatedText, 'Xin chào thế giới', 'Returns cached translation')

  // Case 9B: When user modifies source text, asset cache MUST be invalidated
  // To test provider failure handling, simulate GoogleTranslate error:
  const origTranslate = GoogleTranslate.prototype.translate
  GoogleTranslate.prototype.translate = async () => {
    throw new Error('Google Translate Service Offline 500')
  }

  try {
    await assert.rejects(
      async () => {
        await processTranslation({
          text: 'Edited text that was never translated before',
          targetLanguage: 'vi',
          assetId: trAssetId,
          userId: null, // No LLM fallback
        })
      },
      (err) => err.code === 'TRANSLATION_FAILED',
      'Throws TRANSLATION_FAILED when translation providers fail; never returns original text as translation'
    )
  } finally {
    GoogleTranslate.prototype.translate = origTranslate
  }

  // Verify asset translation was not overwritten with fake translation
  const assetCheck = await queryOne('SELECT translation_text FROM assets WHERE id = ?', [trAssetId])
  assert.equal(assetCheck.translation_text, 'Xin chào thế giới', 'Preserves previous valid translation, does not store error')
}

// 10. Database Validation: saveTimeline strict enforcement
{
  console.log('--- 10. Database Validation: saveTimeline strict constraint enforcement ---')
  const defaultTracks = await ensureDefaultTracks(projectId)
  const imageTrack = defaultTracks.find((t) => t.track_type === 'image')

  // Case 10A: Invalid track_id belonging to another project
  await assert.rejects(
    async () => {
      await saveTimeline({
        projectId,
        tracks: [{ id: 'non-existent-track-xyz', name: 'Fake Track' }],
        clips: [],
      })
    },
    (err) => err.code === 'INVALID_TIMELINE_DATA' && err.message.includes('non-existent-track-xyz'),
    'Rejects foreign/non-existent track ID'
  )

  // Case 10B: Invalid asset_id belonging to another project
  await assert.rejects(
    async () => {
      await saveTimeline({
        projectId,
        tracks: defaultTracks,
        clips: [
          {
            track_id: imageTrack.id,
            clip_type: 'image',
            asset_id: 'foreign-asset-id-999',
            start_at_sec: 0,
            out_sec: 4,
          },
        ],
      })
    },
    (err) => err.code === 'INVALID_TIMELINE_DATA' && err.message.includes('foreign-asset-id-999'),
    'Rejects foreign/non-existent asset ID'
  )

  // Case 10C: Invalid clip_type
  await assert.rejects(
    async () => {
      await saveTimeline({
        projectId,
        tracks: defaultTracks,
        clips: [
          {
            track_id: imageTrack.id,
            clip_type: 'malicious_script_clip',
            start_at_sec: 0,
            out_sec: 4,
          },
        ],
      })
    },
    (err) => err.code === 'INVALID_TIMELINE_DATA' && err.message.includes('malicious_script_clip'),
    'Rejects invalid clip_type'
  )

  // Case 10D: Invalid time boundaries: start_at_sec < 0
  await assert.rejects(
    async () => {
      await saveTimeline({
        projectId,
        tracks: defaultTracks,
        clips: [
          {
            track_id: imageTrack.id,
            clip_type: 'image',
            start_at_sec: -2.5,
            out_sec: 4,
          },
        ],
      })
    },
    (err) => err.code === 'INVALID_TIMELINE_DATA' && err.message.includes('start_at_sec'),
    'Rejects negative start_at_sec'
  )

  // Case 10E: Invalid time boundaries: out_sec <= in_sec
  await assert.rejects(
    async () => {
      await saveTimeline({
        projectId,
        tracks: defaultTracks,
        clips: [
          {
            track_id: imageTrack.id,
            clip_type: 'image',
            start_at_sec: 0,
            in_sec: 5.0,
            out_sec: 3.0,
          },
        ],
      })
    },
    (err) => err.code === 'INVALID_TIMELINE_DATA' && err.message.includes('out_sec'),
    'Rejects out_sec <= in_sec'
  )

  // Case 10F: Invalid volume (> 2.0 or < 0)
  await assert.rejects(
    async () => {
      await saveTimeline({
        projectId,
        tracks: defaultTracks,
        clips: [
          {
            track_id: imageTrack.id,
            clip_type: 'image',
            start_at_sec: 0,
            out_sec: 4,
            volume: 5.0,
          },
        ],
      })
    },
    (err) => err.code === 'INVALID_TIMELINE_DATA' && err.message.includes('volume'),
    'Rejects volume out of [0, 2.0] range'
  )

  // Case 10G: Valid save persists transactionally
  const validSaved = await saveTimeline({
    projectId,
    tracks: [
      { id: imageTrack.id, volume: 1.2, muted: false, name: 'Images Valid' },
    ],
    clips: [
      {
        id: 'clip-valid-save-1',
        track_id: imageTrack.id,
        clip_type: 'image',
        start_at_sec: 2.0,
        in_sec: 0,
        out_sec: 6.0,
        volume: 1.0,
      },
    ],
  })

  assert.equal(validSaved.clips.length, 1, 'Valid clips persisted')
  assert.equal(validSaved.clips[0].start_at_sec, 2.0, 'start_at_sec matches')
  assert.equal(validSaved.clips[0].out_sec, 6.0, 'out_sec matches')
}

console.log('\nALL PASS: AI Media Composer Assets & Caching tests passed.')

process.exit(0)
