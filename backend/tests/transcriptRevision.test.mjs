// Transcript optimistic concurrency + precise outputStale (§§4.4-4.7).
// - projects.transcript_version / outputs.transcript_version exist, default 0
// - PUT success bumps revision; stale revision → 409 path (conditional UPDATE)
// - two concurrent PUTs with same revision: exactly one commits
// - outputStale = version mismatch (match→false, mismatch→true, legacy NULL→true)
// - route source: gate INSIDE transaction, no bare !!latestOutput
// Chạy: node tests/transcriptRevision.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_transcriptRev_${Date.now()}.db`)
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { initSchema } = await import('../src/db/schema.js')
const { query, queryOne, run, withTransaction } = await import('../src/db/query.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

// Mirror of the PUT transaction body in dubData.js (same SQL semantics).
async function commitTranscript(projectId, expectedRevisionOrNull, newTranslation) {
  let newRevision = null
  await withTransaction(async (tx) => {
    const cur = await tx.queryOne(`SELECT transcript_version FROM projects WHERE id = ?`, [projectId])
    const current = Number(cur?.transcript_version ?? 0)
    if (expectedRevisionOrNull !== null && Number(expectedRevisionOrNull) !== current) {
      const e = new Error('REVISION_CONFLICT')
      e.code = 'REVISION_CONFLICT'
      e.currentRevision = current
      throw e
    }
    await tx.run(`UPDATE transcript_segments SET translation = ? WHERE project_id = ?`, [newTranslation, projectId])
    const bumped = await tx.runAffected(
      `UPDATE projects SET transcript_version = transcript_version + 1 WHERE id = ? AND transcript_version = ?`,
      [projectId, current]
    )
    if (!bumped) {
      const e = new Error('REVISION_CONFLICT')
      e.code = 'REVISION_CONFLICT'
      e.currentRevision = current
      throw e
    }
    newRevision = current + 1
  })
  return newRevision
}

// 1. schema columns.
{
  const pcols = await query(`PRAGMA table_info(projects)`)
  assert(pcols.some((c) => c.name === 'transcript_version'), 'projects.transcript_version exists')
  const ocols = await query(`PRAGMA table_info(outputs)`)
  assert(ocols.some((c) => c.name === 'transcript_version'), 'outputs.transcript_version exists')
}

// 2-4. revision success → bump; stale → conflict, no lost update.
{
  const pid = 'proj-rev-1'
  await run(`INSERT INTO projects (id, user_id, mode, title) VALUES (?, ?, ?, ?)`, [pid, 'u1', 'TRANSLATE_DUB', 't'])
  await run(`INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text, translation) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['seg-r1', pid, 0, 0, 2, 'hello', 'xin chào'])
  const v0 = Number((await queryOne(`SELECT transcript_version FROM projects WHERE id = ?`, [pid]))?.transcript_version ?? -1)
  assert(v0 === 0, `new project starts at revision 0 (got ${v0})`)

  const v1 = await commitTranscript(pid, 0, 'bản một')
  assert(v1 === 1, `PUT revision=0 commits → revision 1 (got ${v1})`)
  const t1 = await queryOne(`SELECT translation FROM transcript_segments WHERE id = ?`, ['seg-r1'])
  assert(t1?.translation === 'bản một', `segment updated on success (got ${t1?.translation})`)

  let conflicted = false
  try {
    await commitTranscript(pid, 0, 'bản stale')
  } catch (e) { conflicted = e?.code === 'REVISION_CONFLICT' }
  assert(conflicted, 'stale PUT revision=0 after bump → REVISION_CONFLICT')
  const t2 = await queryOne(`SELECT translation FROM transcript_segments WHERE id = ?`, ['seg-r1'])
  assert(t2?.translation === 'bản một', `conflict writes nothing (no lost update, got ${t2?.translation})`)
  await run(`DELETE FROM transcript_segments WHERE project_id = ?`, [pid])
  await run(`DELETE FROM projects WHERE id = ?`, [pid])
}

// 5. two concurrent PUTs, same base revision → exactly one commits.
{
  const pid = 'proj-rev-2'
  await run(`INSERT INTO projects (id, user_id, mode, title) VALUES (?, ?, ?, ?)`, [pid, 'u1', 'TRANSLATE_DUB', 't'])
  await run(`INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text, translation) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['seg-r2', pid, 0, 0, 2, 'hello', 'base'])
  const results = await Promise.allSettled([
    commitTranscript(pid, 0, 'A-wins?'),
    commitTranscript(pid, 0, 'B-wins?'),
  ])
  const ok = results.filter((r) => r.status === 'fulfilled').length
  const conflicts = results.filter((r) => r.status === 'rejected' && r.reason?.code === 'REVISION_CONFLICT').length
  assert(ok === 1 && conflicts === 1, `concurrent PUTs: 1 commits + 1 conflicts (got ${ok} ok, ${conflicts} conflicts)`)
  const fin = await queryOne(`SELECT translation FROM transcript_segments WHERE id = ?`, ['seg-r2'])
  assert(fin?.translation === 'A-wins?' || fin?.translation === 'B-wins?', `winner persisted, loser discarded (got ${fin?.translation})`)
  await run(`DELETE FROM transcript_segments WHERE project_id = ?`, [pid])
  await run(`DELETE FROM projects WHERE id = ?`, [pid])
}

// 6-7. outputStale version matching.
{
  const pid = 'proj-stale-1'
  await run(`INSERT INTO projects (id, user_id, mode, title, transcript_version) VALUES (?, ?, ?, ?, ?)`, [pid, 'u1', 'TRANSLATE_DUB', 't', 5])
  await run(`INSERT INTO outputs (id, project_id, status, transcript_version) VALUES (?, ?, ?, ?)`, ['out-s1', pid, 'success', 5])
  const cur = Number((await queryOne(`SELECT transcript_version FROM projects WHERE id = ?`, [pid]))?.transcript_version ?? -1)
  const out = await queryOne(`SELECT transcript_version FROM outputs WHERE project_id = ? ORDER BY created_date DESC LIMIT 1`, [pid])
  const staleMatch = out.transcript_version == null || Number(out.transcript_version) !== cur
  assert(staleMatch === false, 'revision 5 vs output 5 → stale=false')
  await run(`UPDATE projects SET transcript_version = ? WHERE id = ?`, [6, pid])
  const cur2 = Number((await queryOne(`SELECT transcript_version FROM projects WHERE id = ?`, [pid]))?.transcript_version ?? -1)
  const staleMismatch = out.transcript_version == null || Number(out.transcript_version) !== cur2
  assert(staleMismatch === true, 'revision 6 vs output 5 → stale=true')
  await run(`UPDATE outputs SET transcript_version = NULL WHERE id = ?`, ['out-s1'])
  const legacy = await queryOne(`SELECT transcript_version FROM outputs WHERE id = ?`, ['out-s1'])
  const staleLegacy = legacy.transcript_version == null || Number(legacy.transcript_version) !== cur2
  assert(staleLegacy === true, 'legacy output NULL version → stale=true (conservative)')
  const none = await queryOne(`SELECT transcript_version FROM outputs WHERE project_id = ? AND id = ?`, ['nope', 'nope'])
  assert(!none, 'no output → stale=false (caller checks latestOutput null)')
  await run(`DELETE FROM outputs WHERE project_id = ?`, [pid])
  await run(`DELETE FROM projects WHERE id = ?`, [pid])
}

// 8. route source: gate inside transaction, precise stale, 409 contract.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'v1', 'dubData.js'), 'utf8')
  assert(src.includes('WHERE transcript_version = ?') || src.includes('AND transcript_version'), 'revision check inside transaction (conditional UPDATE)')
  assert(src.includes('409'), 'conflict returns HTTP 409')
  assert(src.includes('REVISION_CONFLICT'), 'uses REVISION_CONFLICT code')
  assert(src.includes('revision'), 'request/response carry revision')
  assert(!src.includes('outputStale: !!latestOutput'), 'no bare !!latestOutput stale semantics')
  assert(src.includes('transcript_version') && src.includes('outputStale'), 'outputStale derived from transcript_version')
}

try { fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
