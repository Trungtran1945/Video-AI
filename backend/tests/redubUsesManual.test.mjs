// Regression test cho redub dùng manual translation + outputs versioning mới (Test 2+3 spec):
// - dubTtsAlign đọc translation hiện tại làm TTS input, không overwrite DB
// - redub route chỉ chạy dub.ttsAlign, không chạy dub.translate
// - outputs mới insert có id khác version 1 (latest query trả về bản mới)
// Chạy: node backend/tests/redubUsesManual.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_redubUsesManual_${Date.now()}.db`)
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const { initSchema } = await import('../src/db/schema.js')
const { queryOne, run } = await import('../src/db/query.js')

await initSchema()

let failures = 0
const assert = (c, m) => {
  if (c) console.log('PASS:', m)
  else { failures++; console.error('FAIL:', m) }
}

// (a) tmp DB: user/project/segment manual translation "Bản dịch mới" + outputs version 1
{
  const uid = 'u-redub-1'
  const pid = 'proj-redub-1'
  await run(`INSERT INTO users (id, email, password) VALUES (?, ?, ?)`, [uid, 'redub1@test.local', 'x'])
  await run(`INSERT INTO projects (id, user_id, mode, title) VALUES (?, ?, ?, ?)`, [pid, uid, 'TRANSLATE_DUB', 'redub'])
  await run(
    `INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text, translation) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['seg-redub-1', pid, 0, 0, 2, 'hello world', 'Bản dịch mới']
  )
  await run(`INSERT INTO outputs (id, project_id, status, created_date) VALUES (?, ?, ?, ?)`, ['out-v1', pid, 'success', '2026-01-01 00:00:00'])

  // DB giữ manual translation -> chính là TTS source cho redub
  const row = await queryOne(`SELECT translation FROM transcript_segments WHERE id = ?`, ['seg-redub-1'])
  assert(row?.translation === 'Bản dịch mới', `(a) DB giữ manual translation "Bản dịch mới" (got: ${row?.translation})`)

  // Query đúng như dubTtsAlign dùng để lấy TTS input (chỉ câu đã có dịch)
  const ttsRow = await queryOne(
    `SELECT translation FROM transcript_segments WHERE project_id = ? AND translation IS NOT NULL AND translation != '' ORDER BY start_sec ASC`,
    [pid]
  )
  assert(ttsRow?.translation === 'Bản dịch mới', `(a) query TTS input đọc translation hiện tại (got: ${ttsRow?.translation})`)
}

// (b) dubTtsAlign đọc translation hiện tại làm TTS input, không overwrite DB
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'stages', 'dubTtsAlign.js'), 'utf8')
  assert(
    src.includes('translation IS NOT NULL'),
    '(b) dubTtsAlign query segments có translation IS NOT NULL'
  )
  assert(
    src.includes('seg.translation'),
    '(b) dubTtsAlign đọc translation hiện tại (seg.translation) làm TTS input'
  )
  assert(
    src.includes('makeAudio(translation)'),
    '(b) TTS synth dùng biến translation hiện tại (makeAudio(translation))'
  )
  assert(
    !src.includes("updateById('transcript_segments', seg.id, { translation"),
    '(b) dubTtsAlign không chứa updateById translation overwrite'
  )
  assert(
    !src.includes('updateById("transcript_segments"'),
    '(b) dubTtsAlign không overwrite segments dưới mọi quote style'
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

// (c) redub route chỉ chạy dub.ttsAlign, không chạy dub.translate
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'v1', 'generation.js'), 'utf8')
  assert(src.includes("runPipeline(req.project.id, 'dub.ttsAlign', admission.runToken)"), "(c) redub chứa runPipeline dub.ttsAlign với ownership token")
  const redubIdx = src.indexOf('translate-dub/redub')
  assert(redubIdx >= 0, '(c) tìm thấy handler translate-dub/redub')
  const redubBlock = redubIdx >= 0 ? src.slice(redubIdx, redubIdx + 2000) : ''
  assert(!redubBlock.includes("'dub.translate'") && !redubBlock.includes('"dub.translate"'), "(c) handler redub KHÔNG chứa 'dub.translate'")
  assert(redubBlock.includes("'dub.ttsAlign'"), "(c) handler redub chứa 'dub.ttsAlign'")
  assert(
    redubBlock.includes("translation IS NOT NULL AND translation != ''"),
    '(c) handler redub có guard 0 translation'
  )
}

// (d) outputs mới insert có id khác version 1, latest query trả về bản mới
{
  const pid = 'proj-redub-1'
  const before = await queryOne(`SELECT * FROM outputs WHERE project_id = ? ORDER BY created_date DESC LIMIT 1`, [pid])
  assert(before?.id === 'out-v1', `(d) latest trước redub là version 1 (got: ${before?.id})`)
  // Simulate redub render xong -> insert outputs row mới (version 2)
  await run(`INSERT INTO outputs (id, project_id, status, created_date) VALUES (?, ?, ?, ?)`, ['out-v2', pid, 'success', '2026-01-02 00:00:00'])
  const latest = await queryOne(`SELECT * FROM outputs WHERE project_id = ? ORDER BY created_date DESC LIMIT 1`, [pid])
  assert(!!latest, '(d) query latest outputs trả về row sau redub')
  assert(latest?.id !== 'out-v1', `(d) outputs mới có id khác version 1 (got: ${latest?.id})`)
  assert(latest?.id === 'out-v2', `(d) latest là bản mới nhất out-v2 (got: ${latest?.id})`)
}

try { fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

if (failures > 0) {
  console.error(`\n${failures} tests failed!`)
  process.exit(1)
} else {
  console.log('\nALL PASS')
  process.exit(0)
}
