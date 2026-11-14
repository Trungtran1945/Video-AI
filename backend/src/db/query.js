import {
  getDb,
  save,
  captureMemorySnapshot,
  persistOrRollback,
  restoreMemorySnapshot,
  getDbPersistenceHealth,
  PERSISTENCE_STATES,
  isPostgresMode,
  getPool,
} from '../db.js'

export function convertSqlForPostgres(sql) {
  let s = String(sql || '').trim()

  // 1. Convert INSERT OR IGNORE INTO <table> (...)
  if (/^INSERT\s+OR\s+IGNORE\s+INTO\s+/i.test(s)) {
    s = s.replace(/^INSERT\s+OR\s+IGNORE\s+INTO\s+/i, 'INSERT INTO ')
    if (!/ON\s+CONFLICT/i.test(s)) {
      s = `${s} ON CONFLICT DO NOTHING`
    }
  }

  // 2. Convert INSERT OR REPLACE INTO provider_cache (...)
  if (/^INSERT\s+OR\s+REPLACE\s+INTO\s+provider_cache\b/i.test(s)) {
    s = s.replace(/^INSERT\s+OR\s+REPLACE\s+INTO\s+provider_cache/i, 'INSERT INTO provider_cache')
    if (!/ON\s+CONFLICT/i.test(s)) {
      s = `${s} ON CONFLICT (provider, type, input_hash) DO UPDATE SET result = EXCLUDED.result, expires_date = EXCLUDED.expires_date`
    }
  }

  // 3. Map SQLite rowid to PostgreSQL ctid
  s = s.replace(/\browid\b/gi, 'ctid')

  // 4. Convert parameter placeholders '?' -> '$1', '$2', ... (respecting quoted string literals)
  let paramIndex = 1
  let inSingleQuote = false
  let inDoubleQuote = false
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const char = s[i]
    if (char === "'" && (i === 0 || s[i - 1] !== '\\')) {
      if (!inDoubleQuote) inSingleQuote = !inSingleQuote
      out += char
    } else if (char === '"' && (i === 0 || s[i - 1] !== '\\')) {
      if (!inSingleQuote) inDoubleQuote = !inDoubleQuote
      out += char
    } else if (char === '?' && !inSingleQuote && !inDoubleQuote) {
      out += `$${paramIndex++}`
    } else {
      out += char
    }
  }
  return out
}

export function sanitizeVal(val) {
  if (val === undefined) return null
  if (typeof val === 'object' && val !== null && !(val instanceof Date) && !Buffer.isBuffer(val)) {
    return JSON.stringify(val)
  }
  return val
}

export function sanitizeParams(params) {
  if (!Array.isArray(params)) return []
  return params.map(sanitizeVal)
}

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

function envNumber(name, fallback, minimum = 1) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= minimum ? value : fallback
}

export class WriteQueueFullError extends Error {
  constructor(operation) {
    super(`Database write queue is full for operation ${operation}`)
    this.name = 'WriteQueueFullError'
    this.code = 'DB_WRITE_QUEUE_FULL'
    this.statusCode = 503
    this.retryAfterMs = 100
    this.operation = operation
  }
}

// Persistence policy: consecutive save() failures reach the threshold
// (DB_MAX_SAVE_FAILURES, default 5) → all mutations are rejected until a
// save succeeds again. Reads are never blocked by this.
export class PersistenceBlockedError extends Error {
  constructor(operation) {
    super(`Database persistence is WRITE_BLOCKED for operation ${operation}`)
    this.name = 'PersistenceBlockedError'
    this.code = 'DB_PERSISTENCE_BLOCKED'
    this.statusCode = 503
    this.retryAfterMs = 1000
    this.operation = operation
  }
}

let writeTail = Promise.resolve()
let writeQueueDepth = 0
let writeQueueOldestQueuedAt = 0
let writeQueueLastOperation = null
let writeQueueLastDurationMs = 0
let writeQueueSlowWrites = 0
let writeQueueConfig = {
  maxPendingWrites: envNumber('DB_MAX_PENDING_WRITES', 1000),
  slowWriteMs: envNumber('DB_SLOW_WRITE_MS', 1000, 0),
  logger: console,
}

export function configureWriteQueue({ maxPendingWrites, slowWriteMs, logger } = {}) {
  if (Number.isFinite(Number(maxPendingWrites)) && Number(maxPendingWrites) > 0) {
    writeQueueConfig.maxPendingWrites = Math.floor(Number(maxPendingWrites))
  }
  if (Number.isFinite(Number(slowWriteMs)) && Number(slowWriteMs) >= 0) {
    writeQueueConfig.slowWriteMs = Number(slowWriteMs)
  }
  if (logger && typeof logger.warn === 'function') writeQueueConfig.logger = logger
  return getWriteQueueStats()
}

export function getWriteQueueStats() {
  const now = Date.now()
  return {
    depth: writeQueueDepth,
    maxPendingWrites: writeQueueConfig.maxPendingWrites,
    oldestWaitMs: writeQueueOldestQueuedAt ? now - writeQueueOldestQueuedAt : 0,
    lastOperation: writeQueueLastOperation,
    lastDurationMs: writeQueueLastDurationMs,
    slowWrites: writeQueueSlowWrites,
  }
}

function operationName(options, fallback) {
  const value = options && typeof options === 'object' ? options.op : null
  const name = String(value || fallback || 'db.write')
  return name.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80)
}

// Runs inside the serialized write queue (single writer): rejects the mutation
// while persistence is WRITE_BLOCKED. When this is the only pending write, one
// probe save() is attempted so a recovered disk unblocks writes immediately
// instead of waiting for an external reset.
// The probe is safe: every mutation path snapshots memory and rolls back on
// save failure (captureMemorySnapshot/persistOrRollback below), so memory only
// ever holds writes the caller already observed as SUCCESSFUL — the probe can
// never resurrect a rejected mutation. backend/tests/persistenceAtomicity
// asserts this invariant against the persisted bytes.
async function assertWritable(operation) {
  const health = getDbPersistenceHealth()
  if (health.state !== PERSISTENCE_STATES.WRITE_BLOCKED) return
  if (writeQueueDepth > 1) throw new PersistenceBlockedError(operation)
  try {
    save()
  } catch (_) {
    throw new PersistenceBlockedError(operation)
  }
  if (getDbPersistenceHealth().state === PERSISTENCE_STATES.WRITE_BLOCKED) {
    throw new PersistenceBlockedError(operation)
  }
}

export function withWriteLock(fn, options = {}) {
  const operation = operationName(options, 'db.write')
  if (writeQueueDepth >= writeQueueConfig.maxPendingWrites) {
    return Promise.reject(new WriteQueueFullError(operation))
  }

  const enqueuedAt = Date.now()
  writeQueueDepth += 1
  if (!writeQueueOldestQueuedAt) writeQueueOldestQueuedAt = enqueuedAt

  const task = writeTail.then(async () => {
    const waitMs = Date.now() - enqueuedAt
    const startedAt = Date.now()
    try {
      await assertWritable(operation)
      return await fn()
    } finally {
      const durationMs = Date.now() - startedAt
      writeQueueLastOperation = operation
      writeQueueLastDurationMs = durationMs
      if (durationMs >= writeQueueConfig.slowWriteMs) {
        writeQueueSlowWrites += 1
        writeQueueConfig.logger.warn(
          `[DB_WRITE] op=${operation} waitMs=${waitMs} durationMs=${durationMs} depth=${writeQueueDepth}`
        )
      }
      writeQueueDepth = Math.max(0, writeQueueDepth - 1)
      if (writeQueueDepth === 0) writeQueueOldestQueuedAt = 0
    }
  })

  writeTail = task.catch(() => {})
  return task
}

// One statement + persistence as a single atomic unit: success means the
// mutation is on disk, a save() failure rolls memory back to the pre-mutation
// snapshot and rethrows the persistence error (no phantom in-memory rows).
async function runInner(sql, params = []) {
  const db = await getDb()
  const snapshot = captureMemorySnapshot()
  db.run(sql, params)
  persistOrRollback(snapshot)
  return true
}

async function runAffectedInner(sql, params = []) {
  const db = await getDb()
  const snapshot = captureMemorySnapshot()
  db.run(sql, params)
  let affected = 0
  try {
    affected = db.getRowsModified()
  } catch (_) {
    affected = 0
  }
  persistOrRollback(snapshot)
  return affected
}

export async function query(sql, params = []) {
  if (isPostgresMode()) {
    const pool = getPool()
    const converted = convertSqlForPostgres(sql)
    const res = await pool.query(converted, sanitizeParams(params))
    return res.rows
  }
  const db = await getDb()
  return rowsToObjects(db.exec(sql, params))
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params)
  return rows[0] || null
}

export async function run(sql, params = [], options = {}) {
  if (isPostgresMode()) {
    const pool = getPool()
    const converted = convertSqlForPostgres(sql)
    await pool.query(converted, sanitizeParams(params))
    return true
  }
  return withWriteLock(() => runInner(sql, params), { op: options.op || 'db.run' })
}

export async function runAffected(sql, params = [], options = {}) {
  if (isPostgresMode()) {
    const pool = getPool()
    const converted = convertSqlForPostgres(sql)
    const res = await pool.query(converted, sanitizeParams(params))
    return res.rowCount ?? 0
  }
  return withWriteLock(() => runAffectedInner(sql, params), { op: options.op || 'db.runAffected' })
}

// Mutation + result read as ONE atomic unit: the result row is read in memory
// BEFORE persisting, so a caller can never observe "failed" for a mutation
// already committed to disk (no post-commit SELECT after persistOrRollback).
export async function runReturningOne(sql, params = [], selectSql, selectParams = [], options = {}) {
  if (isPostgresMode()) {
    const pool = getPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(convertSqlForPostgres(sql), sanitizeParams(params))
      const res = await client.query(convertSqlForPostgres(selectSql), sanitizeParams(selectParams))
      await client.query('COMMIT')
      return res.rows[0] || null
    } catch (err) {
      try { await client.query('ROLLBACK') } catch (_) {}
      throw err
    } finally {
      client.release()
    }
  }
  return withWriteLock(async () => {
    const db = await getDb()
    const snapshot = captureMemorySnapshot()
    let row
    try {
      db.run(sql, params)
      const rows = rowsToObjects(db.exec(selectSql, selectParams))
      row = rows[0] || null
    } catch (err) {
      try { restoreMemorySnapshot(snapshot) } catch (_) {}
      throw err
    }
    persistOrRollback(snapshot)
    return row
  }, { op: options.op || 'db.runReturningOne' })
}

export async function insert(table, obj, options = {}) {
  if (isPostgresMode()) {
    const pool = getPool()
    const cols = Object.keys(obj)
    const params = cols.map((c) => sanitizeVal(obj[c]))
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
    const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders}) RETURNING *`
    const res = await pool.query(sql, params)
    return res.rows[0] || null
  }
  return withWriteLock(async () => {
    const db = await getDb()
    const snapshot = captureMemorySnapshot()
    const cols = Object.keys(obj)
    const placeholders = cols.map(() => '?').join(', ')
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`
    let row
    try {
      db.run(sql, cols.map((c) => obj[c]))
      // Read the result row IN MEMORY before persisting: the row returned to
      // the caller is computed pre-commit, so no fallible read can make the
      // API report failure for a mutation already written to disk.
      const rows = rowsToObjects(obj.id
        ? db.exec(`SELECT * FROM ${table} WHERE id = ?`, [obj.id])
        : db.exec(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT 1`))
      row = rows[0] || null
      if (!row) throw new Error(`[DB] insert(${table}): row not visible after insert`)
    } catch (err) {
      // Failed before persist → discard the in-memory mutation, so rejection
      // always means "not persisted" and a retry cannot duplicate.
      try { restoreMemorySnapshot(snapshot) } catch (_) {}
      throw err
    }
    persistOrRollback(snapshot)
    return row
  }, { op: options.op || `insert.${table}` })
}

export async function updateById(table, id, obj, options = {}) {
  if (isPostgresMode()) {
    const pool = getPool()
    const cols = Object.keys(obj)
    const params = cols.map((c) => sanitizeVal(obj[c]))
    const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')
    params.push(id)
    const sql = `UPDATE "${table}" SET ${sets} WHERE id = $${params.length} RETURNING *`
    const res = await pool.query(sql, params)
    return res.rows[0] || null
  }
  return withWriteLock(async () => {
    const db = await getDb()
    const snapshot = captureMemorySnapshot()
    const cols = Object.keys(obj)
    const sets = cols.map((c) => `${c} = ?`).join(', ')
    const sql = `UPDATE ${table} SET ${sets} WHERE id = ?`
    let row
    try {
      db.run(sql, [...cols.map((c) => obj[c]), id])
      const rows = rowsToObjects(db.exec(`SELECT * FROM ${table} WHERE id = ?`, [id]))
      row = rows[0] || null
    } catch (err) {
      try { restoreMemorySnapshot(snapshot) } catch (_) {}
      throw err
    }
    persistOrRollback(snapshot)
    return row
  }, { op: options.op || `update.${table}` })
}

export async function findById(table, id) {
  return queryOne(`SELECT * FROM ${table} WHERE id = ?`, [id])
}

export async function withTransaction(fn, options = {}) {
  if (isPostgresMode()) {
    const pool = getPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const tx = {
        async query(sql, params = []) {
          const converted = convertSqlForPostgres(sql)
          const res = await client.query(converted, sanitizeParams(params))
          return res.rows
        },
        async queryOne(sql, params = []) {
          const rows = await this.query(sql, params)
          return rows[0] || null
        },
        async run(sql, params = []) {
          const converted = convertSqlForPostgres(sql)
          await client.query(converted, sanitizeParams(params))
          return true
        },
        async runAffected(sql, params = []) {
          const converted = convertSqlForPostgres(sql)
          const res = await client.query(converted, sanitizeParams(params))
          return res.rowCount ?? 0
        },
        async insert(table, obj) {
          const cols = Object.keys(obj)
          const params = cols.map((c) => sanitizeVal(obj[c]))
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
          const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders}) RETURNING *`
          const res = await client.query(sql, params)
          return res.rows[0] || null
        },
        async updateById(table, id, obj) {
          const cols = Object.keys(obj)
          const params = cols.map((c) => sanitizeVal(obj[c]))
          const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')
          params.push(id)
          const sql = `UPDATE "${table}" SET ${sets} WHERE id = $${params.length} RETURNING *`
          const res = await client.query(sql, params)
          return res.rows[0] || null
        },
      }
      const out = await fn(tx)
      await client.query('COMMIT')
      return out
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch (_) {}
      throw err
    } finally {
      client.release()
    }
  }
  return withWriteLock(async () => {
    const db = await getDb()
    // Pre-transaction image: the restore point if persistence fails after the
    // in-memory COMMIT, or if SQL ROLLBACK cannot undo the work.
    const snapshot = captureMemorySnapshot()
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
        db.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`, cols.map((c) => obj[c]))
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
    let out
    db.exec('BEGIN')
    try {
      out = await fn(tx)
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch (_) {
        // SQL ROLLBACK was unavailable (e.g. the failure happened after
        // COMMIT): rebuild memory from the pre-transaction image so no part of
        // a transaction the caller is told failed can survive.
        try { restoreMemorySnapshot(snapshot) } catch (_) {}
      }
      throw err
    }
    // The in-memory transaction committed — persistence must agree before the
    // caller may observe success. A save() failure restores the pre-tx image,
    // so memory and disk both stay BEFORE the transaction.
    persistOrRollback(snapshot)
    return out
  }, { op: options.op || 'db.transaction' })
}

export default {
  query,
  queryOne,
  run,
  runAffected,
  runReturningOne,
  insert,
  updateById,
  findById,
  withTransaction,
  withWriteLock,
  configureWriteQueue,
  getWriteQueueStats,
  WriteQueueFullError,
  PersistenceBlockedError,
  convertSqlForPostgres,
  sanitizeVal,
  sanitizeParams,
}
