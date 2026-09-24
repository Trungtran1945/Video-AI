import { getDb, save } from '../db.js'

// sql.js returns [{ columns: [...], values: [[...]] }]
function rowsToObjects(result) {
  if (!result || result.length === 0) return []
  const { columns, values } = result[0]
  return values.map((row) => {
    const obj = {}
    columns.forEach((c, i) => {
      obj[c] = row[i]
    })
    return obj
  })
}

// Process-local write serialization for sql.js (single in-memory DB + file save).
// Node.js interleaves async callbacks: two concurrent withTransaction() calls
// would otherwise both BEGIN before either COMMITs, corrupting txn semantics.
// All WRITEs (run/runAffected/insert/updateById/withTransaction) go through
// the same Promise-tail gate so ordering is strict: WRITE A → WRITE B → TXN C.
// SELECTs (query/queryOne/findById) stay ungated (read-only, no save()).
// No busy-wait, no setInterval. Queue survives failures; caller errors propagate.
let writeTail = Promise.resolve()

export function withWriteLock(fn) {
  const task = writeTail.then(() => fn())
  // Tail must never reject or the queue dies; caller still gets original result/error.
  writeTail = task.catch(() => {})
  return task
}

async function runInner(sql, params = []) {
  const db = await getDb()
  db.run(sql, params)
  save()
  return true
}

async function runAffectedInner(sql, params = []) {
  const db = await getDb()
  db.run(sql, params)
  let affected = 0
  try {
    affected = db.getRowsModified()
  } catch (_) {
    affected = 0
  }
  save()
  return affected
}

export async function query(sql, params = []) {
  const db = await getDb()
  return rowsToObjects(db.exec(sql, params))
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params)
  return rows[0] || null
}

export async function run(sql, params = []) {
  return withWriteLock(() => runInner(sql, params))
}

// Conditional write with affected-row count (for atomic claims).
// sql.js exposes changes via getRowsModified() right after run().
export async function runAffected(sql, params = []) {
  return withWriteLock(() => runAffectedInner(sql, params))
}

// Insert an object; keys map to columns. Returns the inserted row (with id).
// Whole write+read held under one gate so concurrent inserts can't steal the
// rowid fallback read (normal path passes explicit uuid id anyway).
export async function insert(table, obj) {
  return withWriteLock(async () => {
    const cols = Object.keys(obj)
    const placeholders = cols.map(() => '?').join(', ')
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`
    await runInner(sql, cols.map((c) => obj[c]))
    const id = obj.id || null
    if (id) return queryOne(`SELECT * FROM ${table} WHERE id = ?`, [id])
    // fallback: last row (for autoincrement)
    return queryOne(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT 1`)
  })
}

export async function updateById(table, id, obj) {
  return withWriteLock(async () => {
    const cols = Object.keys(obj)
    const sets = cols.map((c) => `${c} = ?`).join(', ')
    const sql = `UPDATE ${table} SET ${sets} WHERE id = ?`
    await runInner(sql, [...cols.map((c) => obj[c]), id])
    return queryOne(`SELECT * FROM ${table} WHERE id = ?`, [id])
  })
}

export async function findById(table, id) {
  return queryOne(`SELECT * FROM ${table} WHERE id = ?`, [id])
}

// Single transaction helper for sql.js (file-backed, process-local).
// Usage: await withTransaction(async (tx) => { await tx.run(...); ... })
// - Serialized through withWriteLock: only one write txn active per process.
// - BEGIN/COMMIT/ROLLBACK via db.exec; save() only once after COMMIT, never mid-txn.
// - Inside fn MUST use tx.* (never query/run directly) to avoid mid-txn save().
// - Rollback/throw always releases the lock; queue survives failures.
// - No nesting: throws if already in transaction.
export async function withTransaction(fn) {
  return withWriteLock(async () => {
    const db = await getDb()
    const txRows = (result) => rowsToObjects(result)
    const tx = {
      async query(sql, params = []) {
        return txRows(db.exec(sql, params))
      },
      async queryOne(sql, params = []) {
        const rows = txRows(db.exec(sql, params))
        return rows[0] || null
      },
      async run(sql, params = []) {
        db.run(sql, params)
        return true
      },
      async runAffected(sql, params = []) {
        db.run(sql, params)
        try {
          return db.getRowsModified()
        } catch (_) {
          return 0
        }
      },
      async insert(table, obj) {
        const cols = Object.keys(obj)
        const placeholders = cols.map(() => '?').join(', ')
        db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`, cols.map((c) => obj[c]))
        if (obj.id) {
          const rows = txRows(db.exec(`SELECT * FROM ${table} WHERE id = ?`, [obj.id]))
          return rows[0] || null
        }
        const rows = txRows(db.exec(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT 1`))
        return rows[0] || null
      },
      async updateById(table, id, obj) {
        const cols = Object.keys(obj)
        const sets = cols.map((c) => `${c} = ?`).join(', ')
        db.run(`UPDATE ${table} SET ${sets} WHERE id = ?`, [...cols.map((c) => obj[c]), id])
        const rows = txRows(db.exec(`SELECT * FROM ${table} WHERE id = ?`, [id]))
        return rows[0] || null
      },
    }
    db.exec('BEGIN')
    try {
      const out = await fn(tx)
      db.exec('COMMIT')
      save()
      return out
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch (_) {}
      throw err
    }
  })
}

export default { query, queryOne, run, runAffected, insert, updateById, findById, withTransaction, withWriteLock }
