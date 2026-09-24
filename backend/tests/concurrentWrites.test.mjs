// Concurrency: transaction serialization + write gate for sql.js (§§4.1-4.3).
// - only one write transaction active (strict ordering, no A-BEGIN/B-BEGIN interleave)
// - rollback releases mutex, queue survives failures
// - ordinary run() serialized with withTransaction (no uncontrolled interleave)
// - 100 concurrent writes don't corrupt DB (COUNT + integrity_check)
// Chạy: node tests/concurrentWrites.test.mjs
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_concWrites_${Date.now()}.db`)
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const { initSchema } = await import('../src/db/schema.js')
const { query, queryOne, run, withTransaction, withWriteLock } = await import('../src/db/query.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1. transaction serialization: A holds txn open, B must not BEGIN until A done.
{
  await run(`INSERT INTO projects (id, user_id, mode, title) VALUES (?, ?, ?, ?)`, ['p-ser', 'u1', 'TRANSLATE_DUB', 't0'])
  const order = []
  await Promise.all([
    withTransaction(async (tx) => {
      order.push('A-begin')
      await sleep(60)
      await tx.run(`UPDATE projects SET title = ? WHERE id = ?`, ['A', 'p-ser'])
      order.push('A-end')
    }),
    withTransaction(async (tx) => {
      order.push('B-begin')
      await tx.run(`UPDATE projects SET title = ? WHERE id = ?`, ['B', 'p-ser'])
      order.push('B-end')
    }),
  ])
  const strict = (order[0] === 'A-begin' && order[1] === 'A-end' && order[2] === 'B-begin' && order[3] === 'B-end')
    || (order[0] === 'B-begin' && order[1] === 'B-end' && order[2] === 'A-begin' && order[3] === 'A-end')
  assert(strict, `transactions serialized strictly (got ${order.join(',')})`)
  await run(`DELETE FROM projects WHERE id = ?`, ['p-ser'])
}

// 2. rollback releases mutex: failing txn doesn't block next txn.
{
  await run(`INSERT INTO projects (id, user_id, mode, title) VALUES (?, ?, ?, ?)`, ['p-rb', 'u1', 'TRANSLATE_DUB', 't0'])
  let threw = false
  try {
    await withTransaction(async (tx) => {
      await tx.run(`UPDATE projects SET title = ? WHERE id = ?`, ['BAD', 'p-rb'])
      await sleep(20)
      throw new Error('boom')
    })
  } catch (_) { threw = true }
  assert(threw, 'failing transaction propagates error')
  const after = await withTransaction(async (tx) => {
    await tx.run(`UPDATE projects SET title = ? WHERE id = ?`, ['GOOD', 'p-rb'])
    return 'next-ok'
  })
  assert(after === 'next-ok', 'transaction after rollback still runs (lock released)')
  const row = await queryOne(`SELECT title FROM projects WHERE id = ?`, ['p-rb'])
  assert(row?.title === 'GOOD', `rollback left no partial write (got ${row?.title})`)
  await run(`DELETE FROM projects WHERE id = ?`, ['p-rb'])
}

// 3. ordinary write vs transaction serialization (WRITE A, WRITE B, TXN C ordered).
{
  await run(`INSERT INTO projects (id, user_id, mode, title) VALUES (?, ?, ?, ?)`, ['p-mix', 'u1', 'TRANSLATE_DUB', 't0'])
  const order = []
  const txn = withTransaction(async (tx) => {
    order.push('TXN-begin')
    await sleep(50)
    await tx.run(`UPDATE projects SET title = ? WHERE id = ?`, ['TXN', 'p-mix'])
    order.push('TXN-end')
  })
  const w1 = (async () => { await sleep(5); await run(`UPDATE projects SET title = ? WHERE id = ?`, ['W1', 'p-mix']); order.push('W1'); })()
  const w2 = (async () => { await sleep(10); await run(`UPDATE projects SET title = ? WHERE id = ?`, ['W2', 'p-mix']); order.push('W2'); })()
  await Promise.all([txn, w1, w2])
  // TXN started first so it holds the gate; W1/W2 queue behind it.
  assert(order[0] === 'TXN-begin' && order[1] === 'TXN-end', `ordinary writes wait for active transaction (got ${order.join(',')})`)
  assert(order.includes('W1') && order.includes('W2'), 'both ordinary writes completed')
  await run(`DELETE FROM projects WHERE id = ?`, ['p-mix'])
}

// 4. queue survives ordinary write failure.
{
  let threw = false
  try {
    await withWriteLock(async () => { throw new Error('write fail') })
  } catch (_) { threw = true }
  assert(threw, 'withWriteLock propagates caller error')
  const ok = await withWriteLock(async () => 'alive')
  assert(ok === 'alive', 'write queue alive after failure')
}

// 5. 100 concurrent writes: no corruption, DB valid.
{
  const rows = await query(`SELECT COUNT(*) as cnt FROM provider_cache`)
  const before = Number(rows?.[0]?.cnt ?? 0)
  await Promise.all(Array.from({ length: 100 }, (_, i) =>
    run(`INSERT INTO provider_cache (id, provider, type, input_hash, result) VALUES (?, ?, ?, ?, ?)`,
      [`conc-${Date.now()}-${i}`, 'test', 'conc', `h-${Date.now()}-${i}`, '{}'])
  ))
  const afterRows = await query(`SELECT COUNT(*) as cnt FROM provider_cache WHERE provider = ?`, ['test'])
  assert(Number(afterRows?.[0]?.cnt ?? 0) >= 100, `100 concurrent writes committed (got ${afterRows?.[0]?.cnt})`)
  const check = await query(`PRAGMA integrity_check`)
  const ok = check.length > 0 && String(Object.values(check[0])[0]).toLowerCase() === 'ok'
  assert(ok, 'database file valid after concurrent writes (integrity_check ok)')
  await run(`DELETE FROM provider_cache WHERE provider = ?`, ['test'])
  void before
}

try { const fs = await import('node:fs'); fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
