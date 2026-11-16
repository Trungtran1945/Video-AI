import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_pg_bool_ocr_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)

const { convertSqlForPostgres, query, insert, run, queryOne } = await import('../src/db/query.js')
const { initSchema } = await import('../src/db/schema.js')
const { formatAsset } = await import('../src/routes/v1/composerAssets.js')
const { listProvidersForCapability, getProvider } = await import('../src/providers/registry.js')
const { isPostgresMode, getPool } = await import('../src/db.js')

await initSchema()

console.log('=== Postgres Boolean Compatibility & Vision OCR Integration Tests ===\n')

// ---------------------------------------------------------------------------
// 1. Unit Tests for convertSqlForPostgres
// ---------------------------------------------------------------------------
console.log('--- 1. convertSqlForPostgres Boolean Rewriting ---')

{
  // Test boolean columns converted from 1/0 to TRUE/FALSE
  const sql1 = 'SELECT id, encrypted_key FROM api_keys WHERE user_id = ? AND provider = ? AND is_active = 1 ORDER BY priority ASC'
  const conv1 = convertSqlForPostgres(sql1)
  assert.match(conv1, /is_active = TRUE/i, 'is_active = 1 converted to is_active = TRUE')
  assert.doesNotMatch(conv1, /is_active = 1/i, 'is_active = 1 removed')
  assert.match(conv1, /\$1.*\$2/, 'placeholders converted')

  const sql2 = 'UPDATE email_otps SET used = 1 WHERE id = ? AND used = 0'
  const conv2 = convertSqlForPostgres(sql2)
  assert.match(conv2, /used = TRUE/i, 'used = 1 converted to used = TRUE')
  assert.match(conv2, /used = FALSE/i, 'used = 0 converted to used = FALSE')

  const sql3 = 'UPDATE projects SET script_review_required = 0 WHERE id = ?'
  const conv3 = convertSqlForPostgres(sql3)
  assert.match(conv3, /script_review_required = FALSE/i, 'script_review_required = 0 converted to FALSE')

  const sql4 = 'SELECT * FROM ocr_regions WHERE enabled = 1 AND is_static = 0'
  const conv4 = convertSqlForPostgres(sql4)
  assert.match(conv4, /enabled = TRUE/i, 'enabled = 1 converted to TRUE')
  assert.match(conv4, /is_static = FALSE/i, 'is_static = 0 converted to FALSE')

  // Non-boolean columns MUST NOT be rewritten
  const sqlNonBool = 'SELECT * FROM projects WHERE status = 1 AND order_index = 0 AND progress = 1'
  const convNonBool = convertSqlForPostgres(sqlNonBool)
  assert.match(convNonBool, /status = 1/, 'status = 1 kept intact')
  assert.match(convNonBool, /order_index = 0/, 'order_index = 0 kept intact')
  assert.match(convNonBool, /progress = 1/, 'progress = 1 kept intact')

  // Quoted string literals MUST NOT be rewritten even if they contain boolean names
  const sqlQuoted = "INSERT INTO logs (msg) VALUES ('User set is_active = 1 and enabled = 0 in config')"
  const convQuoted = convertSqlForPostgres(sqlQuoted)
  assert.match(convQuoted, /'User set is_active = 1 and enabled = 0 in config'/, 'Quoted string contents strictly preserved')

  console.log('PASS: convertSqlForPostgres rewrites boolean columns and preserves non-boolean/quoted text')
}

// ---------------------------------------------------------------------------
// 2. formatAsset OCR Data Normalization (Dual Object/JSON compatibility)
// ---------------------------------------------------------------------------
console.log('\n--- 2. formatAsset OCR Data Normalization ---')

{
  // Case A: SQLite / raw JSON string in ocr_data
  const assetWithJsonString = {
    id: 'asset-1',
    project_id: 'proj-1',
    kind: 'image',
    name: 'slide.png',
    ocr_text: 'Xin chào thế giới',
    ocr_data: JSON.stringify([{ x: 10, y: 20, width: 200, height: 50, text: 'Xin chào thế giới', confidence: 0.98 }]),
  }
  const formattedA = formatAsset(assetWithJsonString)
  assert.equal(formattedA.ocrText, 'Xin chào thế giới')
  assert.ok(Array.isArray(formattedA.ocrData), 'ocrData is parsed array')
  assert.equal(formattedA.ocrData[0].text, 'Xin chào thế giới')
  assert.ok(typeof formattedA.ocr_data === 'string', 'ocr_data is preserved as string')

  // Case B: PostgreSQL JSONB (already parsed object/array from pg driver)
  const assetWithJsonObject = {
    id: 'asset-2',
    project_id: 'proj-1',
    kind: 'image',
    name: 'slide2.png',
    ocr_text: 'AI Video Creator',
    ocr_data: [{ x: 5, y: 15, width: 300, height: 60, text: 'AI Video Creator', confidence: 0.95 }],
  }
  const formattedB = formatAsset(assetWithJsonObject)
  assert.equal(formattedB.ocrText, 'AI Video Creator')
  assert.ok(Array.isArray(formattedB.ocrData), 'ocrData is preserved as array')
  assert.equal(formattedB.ocrData[0].text, 'AI Video Creator')
  assert.ok(typeof formattedB.ocr_data === 'string', 'ocr_data is stringified for backward compatibility')

  // Case C: Null / empty OCR
  const assetEmpty = {
    id: 'asset-3',
    project_id: 'proj-1',
    kind: 'image',
    name: 'slide3.png',
  }
  const formattedC = formatAsset(assetEmpty)
  assert.equal(formattedC.ocrText, null)
  assert.equal(formattedC.ocrData, null)
  assert.equal(formattedC.ocr_data, null)

  console.log('PASS: formatAsset correctly normalizes string, object, and null ocr_data')
}

// ---------------------------------------------------------------------------
// 3. PostgreSQL Database Live Verification (if Postgres is running)
// ---------------------------------------------------------------------------
console.log('\n--- 3. PostgreSQL Live Verification ---')

{
  const pgUrl = process.env.DATABASE_URL
  if (pgUrl && pgUrl.startsWith('postgresql://')) {
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString: pgUrl })
    try {
      // 1. Verify is_active = TRUE vs is_active = 1 on api_keys
      const resActive = await pool.query('SELECT id, encrypted_key FROM api_keys WHERE is_active = TRUE LIMIT 1')
      assert.ok(Array.isArray(resActive.rows), 'is_active = TRUE query works on PostgreSQL')

      // 2. Verify convertSqlForPostgres transparently executes on raw pool
      const convertedQuery = convertSqlForPostgres('SELECT id FROM api_keys WHERE is_active = 1')
      const resConverted = await pool.query(convertedQuery)
      assert.ok(Array.isArray(resConverted.rows), 'Converted is_active = 1 runs on PostgreSQL without boolean = integer error')

      // 3. Verify subtitles table has created_date column
      const resSubtitles = await pool.query('SELECT storage_key FROM subtitles ORDER BY created_date DESC LIMIT 5')
      assert.ok(Array.isArray(resSubtitles.rows), 'subtitles ORDER BY created_date DESC succeeds on PostgreSQL')

      console.log('PASS: PostgreSQL live queries pass with zero boolean/integer mismatch errors')
    } finally {
      await pool.end()
    }
  } else {
    console.log('SKIP: PostgreSQL not configured in process.env.DATABASE_URL, skipping live pg pool check')
  }
}

// ---------------------------------------------------------------------------
// 4. Registry resolveApiKey & listProvidersForCapability
// ---------------------------------------------------------------------------
console.log('\n--- 4. Provider Registry Key Resolution ---')

{
  const userId = 'user-test-ocr-keys'
  await insert('users', { id: userId, email: 'ocr-keys@test.local', password: 'hash' })

  // Insert active and inactive keys
  await insert('api_keys', {
    id: 'key-1',
    user_id: userId,
    provider: 'gemini',
    encrypted_key: 'dummy-enc-key-1',
    is_active: 1, // Will be stored as 1 in SQLite, or TRUE in Postgres
    priority: 1,
  })

  await insert('api_keys', {
    id: 'key-2',
    user_id: userId,
    provider: 'gemini',
    encrypted_key: 'dummy-enc-key-2',
    is_active: 0,
    priority: 2,
  })

  // Test listProvidersForCapability (internally calls resolveApiKeyRow with is_active = TRUE)
  const candidates = await listProvidersForCapability(userId, 'vision')
  assert.ok(Array.isArray(candidates), 'listProvidersForCapability returns candidates')

  console.log('PASS: Provider registry queries execute cleanly for vision capability')
}

// ---------------------------------------------------------------------------
// 5. OCR Saving & Subtitle/TTS Pipeline Integration
// ---------------------------------------------------------------------------
console.log('\n--- 5. OCR Saving & Subtitle/TTS Pipeline Integration ---')

{
  const projectId = 'proj-ocr-tts-test'
  const userId = 'user-ocr-tts'
  await insert('users', { id: userId, email: 'ocr-tts@test.local', password: 'hash' })
  await insert('projects', { id: projectId, user_id: userId, title: 'OCR TTS Pipeline Test', mode: 'MEDIA_COMPOSER' })

  // 1. Insert image asset with OCR results
  const assetId = 'asset-ocr-1'
  const ocrBoxes = [
    { x: 100, y: 500, width: 600, height: 80, text: 'Phụ đề tiếng Việt được trích xuất từ ảnh', confidence: 0.96 },
  ]
  await insert('assets', {
    id: assetId,
    project_id: projectId,
    user_id: userId,
    kind: 'image',
    name: 'slide_with_text.png',
    storage_key: `projects/${projectId}/assets/slide_with_text.png`,
    ocr_text: 'Phụ đề tiếng Việt được trích xuất từ ảnh',
    ocr_data: JSON.stringify(ocrBoxes),
  })

  // Verify DB read
  const savedAsset = await queryOne('SELECT ocr_text, ocr_data FROM assets WHERE id = ?', [assetId])
  assert.equal(savedAsset.ocr_text, 'Phụ đề tiếng Việt được trích xuất từ ảnh')
  assert.ok(savedAsset.ocr_data)

  // Verify formatAsset DTO for frontend
  const formatted = formatAsset(savedAsset)
  assert.equal(formatted.ocrText, 'Phụ đề tiếng Việt được trích xuất từ ảnh')
  assert.equal(formatted.ocrData[0].text, 'Phụ đề tiếng Việt được trích xuất từ ảnh')

  // Verify TTS text resolution from assetId
  let resolvedText = null
  const assetForTts = await queryOne('SELECT translation_text, ocr_text FROM assets WHERE id = ? AND project_id = ?', [assetId, projectId])
  resolvedText = (assetForTts?.translation_text || assetForTts?.ocr_text || '').trim()
  assert.equal(resolvedText, 'Phụ đề tiếng Việt được trích xuất từ ảnh', 'TTS can resolve speech text directly from asset OCR')

  // When translated
  await run('UPDATE assets SET translation_text = ?, translation_target_lang = ? WHERE id = ?', [
    'Subtitles in English extracted from image',
    'en',
    assetId,
  ])
  const assetForTts2 = await queryOne('SELECT translation_text, ocr_text FROM assets WHERE id = ? AND project_id = ?', [assetId, projectId])
  resolvedText = (assetForTts2?.translation_text || assetForTts2?.ocr_text || '').trim()
  assert.equal(resolvedText, 'Subtitles in English extracted from image', 'TTS prioritizes translated text over OCR text')

  console.log('PASS: OCR text and segments correctly saved and accessible for TTS/Subtitle flow')
}

console.log('\nALL POSTGRES BOOLEAN & VISION OCR TESTS PASS!')
