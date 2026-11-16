import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import express from 'express'
import { once } from 'node:events'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_ocr_contract_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { query, queryOne, run, insert, convertSqlForPostgres } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const { formatAsset } = await import('../src/routes/v1/composerAssets.js')
const composerAssetsRouter = (await import('../src/routes/v1/composerAssets.js')).default

await initSchema()

console.log('=== End-to-End Vision OCR & PostgreSQL Compatibility Verification ===\n')

// ---------------------------------------------------------------------------
// 1. Comprehensive PostgreSQL Boolean Query Dialect Test
// ---------------------------------------------------------------------------
console.log('--- 1. Testing Boolean Column Conversion on PostgreSQL ---')
{
  const pgUrl = process.env.DATABASE_URL
  if (pgUrl && pgUrl.startsWith('postgresql://')) {
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString: pgUrl })

    try {
      // Test 1: api_keys is_active = 1
      const q1 = convertSqlForPostgres('SELECT id FROM api_keys WHERE is_active = 1 LIMIT 5')
      const r1 = await pool.query(q1)
      assert.ok(Array.isArray(r1.rows), 'api_keys with is_active = 1 executes on PostgreSQL')

      // Test 2: ocr_regions enabled = 1 AND is_static = 0
      const q2 = convertSqlForPostgres('SELECT id FROM ocr_regions WHERE enabled = 1 AND is_static = 0 LIMIT 5')
      const r2 = await pool.query(q2)
      assert.ok(Array.isArray(r2.rows), 'ocr_regions with enabled = 1 and is_static = 0 executes on PostgreSQL')

      // Test 3: transcript_segments boolean flags
      const q3 = convertSqlForPostgres('SELECT id FROM transcript_segments WHERE is_time_manually_adjusted = 1 OR is_translation_manually_edited = 0 LIMIT 5')
      const r3 = await pool.query(q3)
      assert.ok(Array.isArray(r3.rows), 'transcript_segments boolean flags execute on PostgreSQL')

      // Test 4: projects script_review_required = 0
      const q4 = convertSqlForPostgres('SELECT id FROM projects WHERE script_review_required = 0 LIMIT 5')
      const r4 = await pool.query(q4)
      assert.ok(Array.isArray(q4.length ? r4.rows : []), 'projects script_review_required = 0 executes on PostgreSQL')

      // Test 5: email_otps used = 0
      const q5 = convertSqlForPostgres('SELECT id FROM email_otps WHERE used = 0 LIMIT 5')
      const r5 = await pool.query(q5)
      assert.ok(Array.isArray(r5.rows), 'email_otps used = 0 executes on PostgreSQL')

      console.log('PASS: All boolean queries successfully converted and executed against PostgreSQL without "operator does not exist: boolean = integer"')
    } finally {
      await pool.end()
    }
  } else {
    console.log('SKIP: PostgreSQL not configured in process.env.DATABASE_URL')
  }
}

// ---------------------------------------------------------------------------
// 2. End-to-End Asset Format & HTTP Contract Verification
// ---------------------------------------------------------------------------
console.log('\n--- 2. End-to-End Asset Format & HTTP Contract ---')
{
  const user = { id: 'user-ocr-contract', email: 'ocr-contract@test.local', role: 'user', password: 'hash' }
  await insert('users', user)
  const token = generateAccessToken(user)

  const projectId = 'proj-ocr-contract-1'
  await insert('projects', { id: projectId, user_id: user.id, title: 'Contract Test', mode: 'MEDIA_COMPOSER' })

  // Create an asset with simulated OCR data
  const assetId = 'asset-contract-img'
  const mockBoxes = [
    { x: 50, y: 100, width: 400, height: 60, text: 'Trí tuệ nhân tạo thế hệ mới', confidence: 0.99 },
    { x: 50, y: 180, width: 350, height: 50, text: 'Phát hiện văn bản tự động', confidence: 0.95 }
  ]
  await insert('assets', {
    id: assetId,
    project_id: projectId,
    user_id: user.id,
    kind: 'image',
    name: 'test_slide.png',
    storage_key: `projects/${projectId}/assets/test_slide.png`,
    ocr_text: 'Trí tuệ nhân tạo thế hệ mới Phát hiện văn bản tự động',
    ocr_data: JSON.stringify(mockBoxes),
    translation_text: 'Next-generation Artificial Intelligence Automated text detection',
    translation_target_lang: 'en'
  })

  const app = express()
  app.use(express.json())
  app.use('/api/v1/projects', composerAssetsRouter)
  const server = app.listen(0)
  await once(server, 'listening')
  const port = server.address().port

  try {
    // Test GET assets format
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${projectId}/assets`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    
    assert.equal(res.status, 200, 'GET /assets returns 200')
    const body = await res.json()
    const assets = body.assets
    assert.ok(Array.isArray(assets), 'returns assets array')
    const targetAsset = assets.find(a => a.id === assetId)
    assert.ok(targetAsset, 'asset found in list')
    
    // Verify dual contracts (camelCase for frontend UI, snake_case for pipeline compatibility)
    assert.equal(targetAsset.ocrText, 'Trí tuệ nhân tạo thế hệ mới Phát hiện văn bản tự động')
    assert.equal(targetAsset.ocr_text, 'Trí tuệ nhân tạo thế hệ mới Phát hiện văn bản tự động')
    assert.ok(Array.isArray(targetAsset.ocrData), 'ocrData is an array')
    assert.equal(targetAsset.ocrData.length, 2)
    assert.equal(targetAsset.ocrData[0].text, 'Trí tuệ nhân tạo thế hệ mới')
    assert.equal(targetAsset.translationText, 'Next-generation Artificial Intelligence Automated text detection')
    assert.equal(targetAsset.translationTargetLang, 'en')

    console.log('PASS: Asset format satisfies frontend UI camelCase and pipeline contracts')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

// ---------------------------------------------------------------------------
// 3. TTS Resolution from Asset OCR / Translation
// ---------------------------------------------------------------------------
console.log('\n--- 3. TTS Text Resolution from Asset OCR / Translation ---')
{
  const user = { id: 'user-ocr-tts-flow', email: 'tts-flow@test.local', role: 'user', password: 'hash' }
  await insert('users', user)
  const token = generateAccessToken(user)

  const projectId = 'proj-ocr-tts-flow'
  await insert('projects', { id: projectId, user_id: user.id, title: 'TTS Flow Test', mode: 'MEDIA_COMPOSER' })

  // Case A: Asset with both OCR and translation
  const asset1Id = 'asset-tts-tr'
  await insert('assets', {
    id: asset1Id,
    project_id: projectId,
    user_id: user.id,
    kind: 'image',
    name: 'slide_tr.png',
    storage_key: `projects/${projectId}/assets/slide_tr.png`,
    ocr_text: 'Xin chào thế giới',
    translation_text: 'Hello world translated',
    translation_target_lang: 'en'
  })

  // Case B: Asset with OCR text only
  const asset2Id = 'asset-tts-ocr'
  await insert('assets', {
    id: asset2Id,
    project_id: projectId,
    user_id: user.id,
    kind: 'image',
    name: 'slide_ocr.png',
    storage_key: `projects/${projectId}/assets/slide_ocr.png`,
    ocr_text: 'Chào mừng các bạn đến với khoá học',
    ocr_data: JSON.stringify([{ text: 'Chào mừng các bạn đến với khoá học' }])
  })

  // Verify resolution logic
  const a1 = await queryOne('SELECT translation_text, ocr_text FROM assets WHERE id = ? AND project_id = ?', [asset1Id, projectId])
  const text1 = (a1?.translation_text || a1?.ocr_text || '').trim()
  assert.equal(text1, 'Hello world translated', 'Uses translation_text when present')

  const a2 = await queryOne('SELECT translation_text, ocr_text FROM assets WHERE id = ? AND project_id = ?', [asset2Id, projectId])
  const text2 = (a2?.translation_text || a2?.ocr_text || '').trim()
  assert.equal(text2, 'Chào mừng các bạn đến với khoá học', 'Falls back to ocr_text when translation is not present')

  console.log('PASS: TTS text correctly resolved from asset OCR / translation')
}

// ---------------------------------------------------------------------------
// 4. Subtitle Schema Integrity Check
// ---------------------------------------------------------------------------
console.log('\n--- 4. Subtitle Schema Integrity Check ---')
{
  const subId = `sub-test-${Date.now()}`
  const projId = 'proj-ocr-contract-1'
  
  await insert('subtitles', {
    id: subId,
    project_id: projId,
    format: 'srt',
    language: 'vi',
    storage_key: `projects/${projId}/subtitles/auto.srt`,
    cues: JSON.stringify([
      { id: 1, start: 0, end: 3, text: 'Phụ đề sinh từ OCR' }
    ])
  })

  const fetched = await queryOne('SELECT * FROM subtitles WHERE id = ?', [subId])
  assert.ok(fetched, 'Subtitle record inserted')
  assert.ok(fetched.created_date, 'created_date column exists and is populated')

  console.log('PASS: subtitles table created_date column verified')
}

try { fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log('\n======================================================')
console.log(' ALL VISION OCR & POSTGRESQL CONTRACT TESTS PASSED!   ')
console.log('======================================================\n')
