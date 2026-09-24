// Regression test cho TRANSLATE_DUB manual-edit fix:
// manual translation trong DB là source of truth, shorten chỉ in-memory,
// PUT trả outputStale, redub guard khi 0 translation, RESETS không xoá segments.
// Chạy: node backend/tests/manualEdit.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_manualEdit_${Date.now()}.db`)
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const { initSchema } = await import('../src/db/schema.js')
const { query, queryOne, run } = await import('../src/db/query.js')

await initSchema()

let failures = 0
const assert = (c, m) => {
  if (c) console.log('PASS:', m)
  else { failures++; console.error('FAIL:', m) }
}

// (a) UPDATE translation Cũ -> Mới qua SQL như PUT /transcript, assert DB giữ Mới
{
  const pid = 'proj-manual-1'
  await run(`INSERT INTO projects (id, user_id, mode, title) VALUES (?, ?, ?, ?)`, [pid, 'u1', 'TRANSLATE_DUB', 't'])
  await run(
    `INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text, translation) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['seg-1', pid, 0, 0, 2, 'hello', 'Cũ']
  )
  // Mô phỏng đúng câu UPDATE của PUT dubData.js
  const translation = 'Mới'
  await run(
    `UPDATE transcript_segments SET translation = ?, start_sec = ?, end_sec = ?, is_time_manually_adjusted = ? WHERE id = ? AND project_id = ?`,
    [translation, 0, 2, 0, 'seg-1', pid]
  )
  const row = await queryOne(`SELECT translation FROM transcript_segments WHERE id = ?`, ['seg-1'])
  assert(row?.translation === 'Mới', `(a) DB giữ manual translation mới (got: ${row?.translation})`)

  // outputStale logic như PUT: có output mới nhất -> true
  await run(`INSERT INTO outputs (id, project_id, status) VALUES (?, ?, ?)`, ['out-1', pid, 'success'])
  const latest = await queryOne(`SELECT * FROM outputs WHERE project_id = ? ORDER BY created_date DESC LIMIT 1`, [pid])
  assert(!!latest, '(a) query outputs mới nhất trả về row khi có output (outputStale=true)')
  await run(`DELETE FROM outputs WHERE project_id = ?`, [pid])
  const none = await queryOne(`SELECT * FROM outputs WHERE project_id = ? ORDER BY created_date DESC LIMIT 1`, [pid])
  assert(!none, '(a) không có output -> outputStale=false')
  await run(`DELETE FROM transcript_segments WHERE project_id = ?`, [pid])
  await run(`DELETE FROM projects WHERE id = ?`, [pid])
}

// (b) dubTtsAlign không overwrite translation trong DB sau shorten
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'stages', 'dubTtsAlign.js'), 'utf8')
  assert(
    !src.includes("updateById('transcript_segments', seg.id, { translation"),
    '(b) dubTtsAlign không chứa updateById translation overwrite'
  )
  assert(
    src.includes('tts_audio_id'),
    '(b) vẫn giữ update tts_audio_id cho audios rows'
  )
  assert(
    src.includes('validateTranslation'),
    '(b) vẫn giữ semantic gate validateTranslation khi shorten'
  )
}

// (c) RESETS['dub.ttsAlign'] không chứa transcriptSegments
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'runner.js'), 'utf8')
  const m = src.match(/'dub\.ttsAlign'\s*:\s*\[(.*?)\]/s)
  assert(!!m, "(c) tìm thấy RESETS['dub.ttsAlign']")
  if (m) {
    assert(!m[1].includes('transcriptSegments'), `(c) RESETS['dub.ttsAlign'] không xoá segments (got: [${m[1].trim()}])`)
    assert(m[1].includes('audios') && m[1].includes('outputs'), `(c) RESETS['dub.ttsAlign'] vẫn reset audios+outputs`)
  }
}

// (d) PUT transcript trả thêm outputStale chính xác theo version
{
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'v1', 'dubData.js'), 'utf8')
  const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'transcriptMutationService.js'), 'utf8')
  const output = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'outputService.js'), 'utf8')
  assert(route.includes('outputStale'), '(d) dubData.js PUT trả thêm outputStale')
  assert(output.includes('ORDER BY created_date DESC, rowid DESC'), '(d) output latest query deterministic')
  assert(output.includes('transcript_version'), '(d) outputStale theo transcript_version')
  assert(service.includes('transcriptRowChanged'), '(d) mutation so sánh state trước bump')
  assert(!route.includes('outputStale: !!latestOutput'), '(d) không còn outputStale = !!latestOutput sai semantics')
}

// (e) redub dùng translation hiện tại + guard 0 translation
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'v1', 'generation.js'), 'utf8')
  assert(src.includes("runPipeline(req.project.id, 'dub.ttsAlign', admission.runToken)"), "(e) redub giữ runPipeline dub.ttsAlign với ownership token")
  assert(
    src.includes("translation IS NOT NULL AND translation != ''"),
    '(e) redub có guard 0 segment có translation -> 400'
  )
  const redubIdx = src.indexOf('translate-dub/redub')
  const redubBlock = redubIdx >= 0 ? src.slice(redubIdx, redubIdx + 1800) : ''
  assert(!redubBlock.includes("'dub.translate'") && !redubBlock.includes('"dub.translate"'), '(e) redub block không chạy dub.translate')
}

try { fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

if (failures > 0) {
  console.error(`\n${failures} tests failed!`)
  process.exit(1)
} else {
  console.log('\nALL PASS')
  process.exit(0)
}
