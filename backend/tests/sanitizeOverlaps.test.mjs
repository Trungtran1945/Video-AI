import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_sanitize_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne } = await import('../src/db/query.js')
const { sanitizeTranscriptOverlaps } = await import('../src/services/transcriptMutationService.js')
const { validateTranslation, hasHardTranslationError } = await import('../src/pipeline/stages/dubTranslate.js')

await initSchema()

let failures = 0
const assert = (condition, message) => {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

// ── 1. validateTranslation CJK length ratio gate ──
// Incident segments: ratio 8.3-8.8 should NOT be hard errors
const seg86 = hasHardTranslationError('可同伴刚下水没多久', 'Nhưng người bạn đồng hành của anh ta chỉ mới xuống nước được một thời gian ngắn.', 'vi')
assert(seg86.hard === false, `seg 86 (ratio 8.55) is not hard error (hard=${seg86.hard}, errors=${seg86.errors.join(';')})`)

const seg106 = hasHardTranslationError('再拖下去', 'Nếu tình trạng này kéo dài hơn nữa', 'vi')
assert(seg106.hard === false, `seg 106 (ratio 8.75) is not hard error (hard=${seg106.hard}, errors=${seg106.errors.join(';')})`)

const seg111 = hasHardTranslationError('小镇彻底乱了', 'Thị trấn đang trong tình trạng hỗn loạn hoàn toàn.', 'vi')
assert(seg111.hard === false, `seg 111 (ratio 8.33) is not hard error (hard=${seg111.hard}, errors=${seg111.errors.join(';')})`)

// Extreme CJK hallucination (ratio > 12) still HARD
const cjkExtreme = hasHardTranslationError('再拖下去', 'Nếu tình trạng vô cùng tồi tệ và nguy hiểm này cứ tiếp tục kéo dài mãi mãi mà không có bất kỳ ai can thiệp vào để giải quyết', 'vi')
assert(cjkExtreme.hard === true, 'extreme CJK expansion (>12x) remains HARD')

// ── 2. sanitizeTranscriptOverlaps: chunk-boundary prefix duplicate removal ──
const p1 = 'proj-sanitize-prefix'
await insert('projects', {
  id: p1,
  user_id: 'user-test',
  mode: 'TRANSLATE_DUB',
  title: 'test prefix duplicate',
  status: 'running',
  transcript_version: 0,
})

await insert('transcript_segments', {
  id: 'seg-150',
  project_id: p1,
  index_num: 150,
  start_sec: 299.0,
  end_sec: 300.0,
  text: '卡住丽莎的水',
  translation: 'Nước mắc kẹt Lisa',
})
await insert('transcript_segments', {
  id: 'seg-151',
  project_id: p1,
  index_num: 151,
  start_sec: 299.08,
  end_sec: 300.4,
  text: '卡住丽莎的树枝',
  translation: null,
})

const r1 = await sanitizeTranscriptOverlaps(p1, 0)
assert(r1.changed === true, 'r1 reported changed')
assert(r1.removedCount === 1, `r1 removed 1 fragment (removedCount=${r1.removedCount})`)

const segs1 = await query('SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC', [p1])
assert(segs1.length === 1, `only 1 segment remains (got ${segs1.length})`)
assert(segs1[0].id === 'seg-151', `kept segment is seg-151 (got ${segs1[0].id})`)
assert(segs1[0].index_num === 0, `index_num renumbered to 0 (got ${segs1[0].index_num})`)
assert(segs1[0].translation === 'Nước mắc kẹt Lisa', `translation preserved from donor: ${segs1[0].translation}`)

// ── 3. sanitizeTranscriptOverlaps: clamp overlapping timing ──
const p2 = 'proj-sanitize-clamp'
await insert('projects', {
  id: p2,
  user_id: 'user-test',
  mode: 'TRANSLATE_DUB',
  title: 'test clamp',
  status: 'running',
  transcript_version: 0,
})

await insert('transcript_segments', {
  id: 'clamp-0',
  project_id: p2,
  index_num: 0,
  start_sec: 10.0,
  end_sec: 15.0,
  text: 'Segment one',
  translation: 'Đoạn một',
})
await insert('transcript_segments', {
  id: 'clamp-1',
  project_id: p2,
  index_num: 1,
  start_sec: 14.5,
  end_sec: 20.0,
  text: 'Segment two',
  translation: 'Đoạn hai',
})

const r2 = await sanitizeTranscriptOverlaps(p2, 0)
assert(r2.changed === true, 'r2 reported changed')
assert(r2.clampedCount === 1, `r2 clamped 1 segment (clampedCount=${r2.clampedCount})`)

const segs2 = await query('SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC', [p2])
assert(segs2[0].end_sec <= segs2[1].start_sec, `prev.end_sec (${segs2[0].end_sec}) clamped to <= cur.start_sec (${segs2[1].start_sec})`)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
