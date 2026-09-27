// Test ASR-only transcript architecture:
// 1. dubMerge validates ASR transcript directly (no OCR branching)
// 2. ASR transcript segments have source = 'asr', valid timing, and no bounding boxes
// 3. validateForRender operates on ASR transcript without OCR regions
// 4. Subtitle renderer (buildAss) produces deterministic bottom position without OCR bboxes
// Run: node backend/tests/transcriptSource.test.mjs

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai_test_asr_'))
process.env.DB_PATH = path.join(tmpDir, 'test.db')
process.env.STORAGE_DIR = path.join(tmpDir, 'storage')
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const { initSchema } = await import('../src/db/schema.js')
const { run, query } = await import('../src/db/query.js')
const { default: dubMerge, validateForRender } = await import('../src/pipeline/stages/dubMerge.js')
const { buildAss } = await import('../src/pipeline/stages/dubRender.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const pid = 'proj-asr-test'
await run(
  'INSERT INTO projects (id, user_id, mode, title, params, transcript_version) VALUES (?, ?, ?, ?, ?, ?)',
  [pid, 'u1', 'TRANSLATE_DUB', 'Test ASR Project', JSON.stringify({ sourceLanguage: 'en', targetLanguage: 'vi' }), 1]
)

// 1. dubMerge throws if no segments exist from dub.stt
{
  let threw = false
  try {
    await dubMerge({ project: { id: pid, params: JSON.stringify({ sourceLanguage: 'en', targetLanguage: 'vi' }) }, job: { id: 'j1' }, setProgress: () => {} })
  } catch (err) {
    threw = true
    assert(err.message.includes('Thiếu TranscriptSegment từ dub.stt'), `empty segments throws STT message: ${err.message}`)
  }
  assert(threw, 'dubMerge throws when segments table is empty')
}

// 2. Insert valid ASR segments (no bounding boxes, source = 'asr')
const seg1 = {
  id: 'seg-1',
  project_id: pid,
  index_num: 0,
  start_sec: 1.0,
  end_sec: 3.5,
  text: 'Hello world from speech recognition',
  speaker: null,
  language: 'en',
  source: 'asr',
}
const seg2 = {
  id: 'seg-2',
  project_id: pid,
  index_num: 1,
  start_sec: 4.0,
  end_sec: 7.0,
  text: 'This is the second ASR sentence',
  speaker: null,
  language: 'en',
  source: 'asr',
}

for (const s of [seg1, seg2]) {
  await run(
    `INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text, speaker, language, source, ratio_x, ratio_y, ratio_w, ratio_h)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
    [s.id, s.project_id, s.index_num, s.start_sec, s.end_sec, s.text, s.speaker, s.language, s.source]
  )
}

// 3. Verify ASR transcript rows in DB
{
  const rows = await query('SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC', [pid])
  assert(rows.length === 2, '2 ASR transcript rows persisted')
  assert(rows[0].source === 'asr' && rows[1].source === 'asr', 'source is asr for both segments')
  assert(rows[0].ratio_x === null && rows[0].ratio_w === null, 'ASR segments have no visual bounding box (ratio_x is null)')
  assert(rows[0].start_sec === 1.0 && rows[0].end_sec === 3.5, 'valid timestamps on ASR segment 1')
  assert(rows[1].start_sec === 4.0 && rows[1].end_sec === 7.0, 'valid timestamps on ASR segment 2')
}

// 4. dubMerge succeeds and reports source = 'asr'
{
  const res = await dubMerge({
    project: { id: pid, params: JSON.stringify({ sourceLanguage: 'en', targetLanguage: 'vi' }) },
    job: { id: 'j2' },
    setProgress: () => {},
  })
  assert(res.transcriptSegments === 2, 'dubMerge counted 2 ASR segments')
  assert(res.source === 'asr', 'dubMerge returns source=asr')
  assert(res.sourceLanguage === 'en' && res.targetLanguage === 'vi', 'dubMerge preserves language config')
}

// 5. Update translations on ASR segments and validate for render (without OCR regions)
await run('UPDATE transcript_segments SET translation = ? WHERE id = ?', ['Xin chào thế giới từ nhận dạng giọng nói', seg1.id])
await run('UPDATE transcript_segments SET translation = ? WHERE id = ?', ['Đây là câu ASR thứ hai', seg2.id])

{
  const validation = await validateForRender(pid)
  assert(validation.valid === true, `validateForRender succeeds on ASR segments without OCR (errors: ${JSON.stringify(validation.errors)})`)
}

// 6. Test 5: Subtitle rendering (buildAss) produces deterministic bottom position without OCR bboxes
{
  const segments = await query('SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC', [pid])
  const assPath = buildAss(tmpDir, segments, [], {
    width: 1280,
    height: 720,
    title: 'ASR Subtitle Test',
    subPosition: 'bottom',
  })
  const assContent = fs.readFileSync(assPath, 'utf8')
  assert(assContent.includes('Dialogue: 0,'), 'ASS file contains dialogue events')
  assert(assContent.includes('\\an2\\pos(640,648)'), 'ASS places subtitles at deterministic bottom center (an2 pos)')
  assert(assContent.includes('Xin chào thế giới từ nhận dạng giọng nói'), 'ASS contains translated text 1')
  assert(assContent.includes('Đây là câu ASR thứ hai'), 'ASS contains translated text 2')
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}

if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
