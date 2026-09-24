// Transcript atomic + deterministic timing (hardening §§4.1-4.4).
// - batch success commits all; any error → no DB write (proposed-state validated first)
// - minimal-push: only shift on overlap, keep spare gap (no drift)
// - multi-edit deterministic regardless of payload order; explicit-vs-push conflict rejects
// Chạy: node tests/transcriptAtomic.test.mjs
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_transcriptAtomic_${Date.now()}.db`)
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const { initSchema } = await import('../src/db/schema.js')
const { query, queryOne, run, withTransaction } = await import('../src/db/query.js')
const { computeProposedState, validateProposedState, TIMING_GAP } = await import('../src/lib/transcriptTiming.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

function seg(id, idx, s, e, extra = {}) {
  return { id, index_num: idx, start_sec: s, end_sec: e, text: `t${idx}`, translation: `d${idx}`, is_time_manually_adjusted: 0, is_text_manually_edited: 0, is_translation_manually_edited: 0, ...extra }
}

// 1. batch success: text + translation + timing in one proposed state
{
  const all = [seg('a', 0, 0, 5), seg('b', 1, 10, 15), seg('c', 2, 20, 25)]
  const r = computeProposedState(all, [
    { id: 'a', endSec: 6 },
    { id: 'c', translation: 'mới' },
  ], { gap: TIMING_GAP })
  assert(r.errors.length === 0 && r.conflicts.length === 0, 'batch hợp lệ không errors/conflicts')
  assert(r.proposed.get('a').end_sec === 6, 'A end thành 6 trong proposed')
  // B không overlap (10 >= 6+0.1) → không bị shift (no drift)
  assert(r.proposed.get('b').start_sec === 10 && r.proposed.get('b').end_sec === 15, 'B giữ nguyên khi không overlap (no unnecessary shift)')
  assert(r.adjusted.length === 0, 'không có adjusted khi không cần push')
  assert(r.ttsInvalidate.includes('c'), 'translation đổi → tts invalidate')
  const v = validateProposedState(r.ordered, { gap: TIMING_GAP })
  assert(v.ok, 'validate toàn bộ proposed pass')
}

// 2. downstream push only when needed (overlap thật)
{
  const all = [seg('a', 0, 0, 5), seg('b', 1, 5.5, 10)]
  const r = computeProposedState(all, [{ id: 'a', endSec: 7 }], { gap: 0.1 })
  // prevEnd 7 + 0.1 = 7.1 > B.start 5.5 → push B tới 7.1
  assert(r.conflicts.length === 0, 'push overlap không conflict khi B không manual')
  assert(Math.abs(r.proposed.get('b').start_sec - 7.1) < 1e-6, `B push tới 7.1 (got ${r.proposed.get('b').start_sec})`)
  assert(r.adjusted.length === 1 && r.adjusted[0].id === 'b', 'adjusted ghi nhận B')
}

// 3. no unnecessary downstream shift (case trong issue B)
{
  const all = [seg('a', 0, 0, 5), seg('b', 1, 10, 15)]
  const r = computeProposedState(all, [{ id: 'a', endSec: 6 }], { gap: 0.1 })
  assert(r.adjusted.length === 0, 'A 0-5→0-6 không đẩy B 10-15')
  assert(r.proposed.get('b').start_sec === 10, 'B giữ 10')
}

// 4. overlap conflict với previous
{
  const all = [seg('a', 0, 0, 5), seg('b', 1, 5.5, 10)]
  const r = computeProposedState(all, [{ id: 'b', startSec: 4 }], { gap: 0.1 })
  assert(r.conflicts.length > 0 || r.errors.length > 0 || validateProposedState(r.ordered, { gap: 0.1 }).ok === false, 'B start 4 overlap A → conflict/invalid')
}

// 5. multiple edits deterministic (đảo thứ tự payload cùng kết quả)
{
  const all = [seg('a', 0, 0, 5), seg('b', 1, 10, 15), seg('c', 2, 20, 25)]
  const p1 = [{ id: 'a', endSec: 6 }, { id: 'c', translation: 'x' }]
  const p2 = [{ id: 'c', translation: 'x' }, { id: 'a', endSec: 6 }]
  const r1 = computeProposedState(all, p1, { gap: 0.1 })
  const r2 = computeProposedState(all, p2, { gap: 0.1 })
  assert(JSON.stringify([...r1.proposed.entries()]) === JSON.stringify([...r2.proposed.entries()]), 'cùng input khác thứ tự → cùng output')
}

// 6. batch conflict: A đẩy B nhưng payload cũng set B explicit mâu thuẫn → reject
{
  const all = [seg('a', 0, 0, 5), seg('b', 1, 5.5, 10), seg('c', 2, 10.5, 15)]
  // A end 7 → B cần >= 7.1, nhưng explicit B start 5.6 (vẫn overlap) → conflict
  const r = computeProposedState(all, [{ id: 'a', endSec: 7 }, { id: 'b', startSec: 5.6 }], { gap: 0.1 })
  assert(r.conflicts.length > 0, 'explicit B mâu thuẫn với push từ A → conflict toàn batch')
}

// 7. manual flag: push gặp segment manual → conflict
{
  const all = [seg('a', 0, 0, 5), seg('b', 1, 5.5, 10, { is_time_manually_adjusted: 1 })]
  const r = computeProposedState(all, [{ id: 'a', endSec: 7 }], { gap: 0.1 })
  assert(r.conflicts.length > 0, 'push vào segment manual → conflict')
}

// 8. withTransaction rollback: throw giữa txn → DB giữ nguyên
{
  const pid = 'proj-txn-1'
  await run(`INSERT INTO projects (id, user_id, mode, title) VALUES (?, ?, ?, ?)`, [pid, 'u1', 'TRANSLATE_DUB', 't'])
  await run(`INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text) VALUES (?, ?, ?, ?, ?, ?)`, ['s1', pid, 0, 0, 5, 'a'])
  await run(`INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text) VALUES (?, ?, ?, ?, ?, ?)`, ['s2', pid, 1, 10, 15, 'b'])
  let threw = false
  try {
    await withTransaction(async (tx) => {
      await tx.run(`UPDATE transcript_segments SET text = ? WHERE id = ?`, ['CHANGED', 's1'])
      throw new Error('simulated mid-batch failure')
    })
  } catch (_) { threw = true }
  assert(threw, 'transaction throw lan ra ngoài')
  const row = await queryOne(`SELECT text FROM transcript_segments WHERE id = ?`, ['s1'])
  assert(row?.text === 'a', `rollback giữ nguyên (got ${row?.text})`)
  // success path commits
  await withTransaction(async (tx) => {
    await tx.run(`UPDATE transcript_segments SET text = ? WHERE id = ?`, ['OK1', 's1'])
    await tx.run(`UPDATE transcript_segments SET text = ? WHERE id = ?`, ['OK2', 's2'])
  })
  const r1 = await queryOne(`SELECT text FROM transcript_segments WHERE id = ?`, ['s1'])
  const r2 = await queryOne(`SELECT text FROM transcript_segments WHERE id = ?`, ['s2'])
  assert(r1?.text === 'OK1' && r2?.text === 'OK2', 'transaction success commit cả hai')
  await run(`DELETE FROM transcript_segments WHERE project_id = ?`, [pid])
  await run(`DELETE FROM projects WHERE id = ?`, [pid])
}

// 9. transcript route delegates proposed-state transaction to the service
{
  const fs = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const __d = path.dirname(fileURLToPath(import.meta.url))
  const route = fs.readFileSync(path.join(__d, '..', 'src', 'routes', 'v1', 'dubData.js'), 'utf8')
  const service = fs.readFileSync(path.join(__d, '..', 'src', 'services', 'transcriptMutationService.js'), 'utf8')
  const timing = fs.readFileSync(path.join(__d, '..', 'src', 'lib', 'transcriptTiming.js'), 'utf8')
  assert(route.includes('applyTranscriptEdits'), 'dubData delegates to transcript mutation service')
  assert(service.includes('withTransaction'), 'transcript service owns the transaction')
  assert(service.includes('computeProposedState'), 'transcript service owns proposed-state computation')
  assert(timing.includes('ttsInvalidate.push(id)'), 'timing changes invalidate TTS')
  assert(!route.includes('delta > 0'), 'không còn điều kiện delta > 0 đáng nghi')
  assert(!route.includes('start_sec = start_sec + ?'), 'không còn UPDATE push trực tiếp trong loop')
}

try { const fs = await import('node:fs'); fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
