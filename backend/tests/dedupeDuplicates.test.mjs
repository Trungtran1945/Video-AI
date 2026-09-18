// Test cho auto-merge STT lặp nguyên văn (BLOCK_RENDER DUPLICATE_SUBTITLE):
// findDuplicateGroups chỉ gộp trim-khớp chính xác + gap <1.0s;
// dedupeTranscriptSegments gộp DB, keeper giữ start + nới end, copy translation
// khi keeper trống, idempotent, validateForRender hết lỗi DUPLICATE_SUBTITLE.
// Chạy: node tests/dedupeDuplicates.test.mjs
import path from 'node:path'
import os from 'node:os'
import { v4 as uuidv4 } from 'uuid'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_dedupe_${Date.now()}.db`)
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne } = await import('../src/db/query.js')
const { findDuplicateGroups, dedupeTranscriptSegments, validateForRender } = await import('../src/pipeline/stages/dubMerge.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

// 1. findDuplicateGroups: chỉ gộp khớp chính xác + gap <1.0s
{
  const rows = [
    { id: 'a', start_sec: 0, end_sec: 1, text: "It's not a thing." },
    { id: 'b', start_sec: 1.1, end_sec: 2, text: "It's not a thing." },
    { id: 'c', start_sec: 2.1, end_sec: 3, text: 'Cold water bottle.' },
    { id: 'd', start_sec: 3.2, end_sec: 4, text: 'Cold water bottle?' }, // khác dấu câu → không gộp
    { id: 'e', start_sec: 10, end_sec: 11, text: 'How much?' },
    { id: 'f', start_sec: 12.5, end_sec: 13, text: 'How much?' }, // gap 1.5 → không gộp
  ]
  const groups = findDuplicateGroups(rows)
  assert(groups.length === 1 && groups[0].map((s) => s.id).join(',') === 'a,b', 'chỉ gộp trùng nguyên văn gap<1s (got ' + groups.map((g) => g.map((s) => s.id).join('+')).join('|') + ')')
  assert(findDuplicateGroups([]).length === 0, 'rỗng -> không nhóm')
}

// 2. dedupeTranscriptSegments trên DB thật
const projectId = 'proj-dedupe-test'
const params = JSON.stringify({ sourceLanguage: 'en', targetLanguage: 'vi' })
await insert('projects', { id: projectId, user_id: 'user-1', mode: 'TRANSLATE_DUB', title: 'dedupe', status: 'running', params })
const seg = (id, idx, s, e, text, translation) => insert('transcript_segments', {
  id, project_id: projectId, index_num: idx, start_sec: s, end_sec: e, text, translation,
})
await seg('s0', 0, 0, 1, "It's not a thing.", 'Chuyện đó không có thật đâu.')
await seg('s1', 1, 1.1, 2, "It's not a thing.", 'Làm gì có chuyện đó đâu.')
await seg('s2', 2, 2.1, 3, "It's not a thing.", null)
await seg('s3', 3, 5, 6, 'Cold water bottle.', 'Bình nước lạnh.')
await seg('s4', 4, 6.1, 7, 'Cold water bottle?', 'Bình nước lạnh hả?')
await seg('s5', 5, 10, 11, 'How much?', null)
await seg('s6', 6, 11.1, 12, 'How much?', 'Giá bao nhiêu vậy?')
await seg('s7', 7, 20, 21, 'How much?', 'Cái này giá bao nhiêu vậy?')

const r1 = await dedupeTranscriptSegments(projectId)
assert(r1.mergedGroups === 2, `gộp đúng 2 nhóm (got ${r1.mergedGroups})`)
assert(r1.removedCount === 3, `xoá đúng 3 bản trùng (got ${r1.removedCount})`)

const k0 = await queryOne('SELECT * FROM transcript_segments WHERE id = ?', ['s0'])
assert(k0 && Number(k0.end_sec) === 3, `keeper s0 nới end tới 3 (got ${k0?.end_sec})`)
assert(k0?.translation === 'Chuyện đó không có thật đâu.', `keeper s0 giữ translation của nó (got ${k0?.translation})`)
const k5 = await queryOne('SELECT * FROM transcript_segments WHERE id = ?', ['s5'])
assert(k5 && Number(k5.end_sec) === 12, `keeper s5 nới end tới 12 (got ${k5?.end_sec})`)
assert(k5?.translation === 'Giá bao nhiêu vậy?', `keeper trống copy translation donor (got ${k5?.translation})`)
assert(!(await queryOne('SELECT * FROM transcript_segments WHERE id = ?', ['s1'])), 'bản trùng s1 đã xoá')
assert(!(await queryOne('SELECT * FROM transcript_segments WHERE id = ?', ['s6'])), 'bản trùng s6 đã xoá')

const rest = await query('SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY start_sec ASC', [projectId])
assert(rest.length === 5, `còn 5 segment (got ${rest.length})`)
assert(findDuplicateGroups(rest).length === 0, 'sau gộp không còn nhóm trùng')

// 3. validateForRender hết lỗi DUPLICATE_SUBTITLE
{
  const v = await validateForRender(projectId)
  assert(!(v.errors || []).some((e) => e.code === 'DUPLICATE_SUBTITLE'), 'validate hết DUPLICATE_SUBTITLE sau auto-merge')
  assert(v.valid === true, `validate valid=true (errors: ${(v.errors || []).map((e) => e.code).join(',') || 'none'})`)
}

// 4. Idempotent: chạy lại no-op
{
  const r2 = await dedupeTranscriptSegments(projectId)
  assert(r2.removedCount === 0 && r2.mergedGroups === 0, 'chạy lại no-op khi hết trùng')
}

await query('DELETE FROM transcript_segments WHERE project_id = ?', [projectId])
await query('DELETE FROM projects WHERE id = ?', [projectId])

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
