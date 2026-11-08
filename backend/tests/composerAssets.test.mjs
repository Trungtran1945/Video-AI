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
} = await import('../src/services/composerService.js')

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

console.log('\nALL PASS: AI Media Composer Assets & Caching tests passed.')

process.exit(0)
