import { getDb, save, getDbPersistenceHealth, PERSISTENCE_STATES } from '../db.js'

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

export async function run(sql, params = [], options = {}) {
  return withWriteLock(() => runInner(sql, params), { op: options.op || 'db.run' })
}

export async function runAffected(sql, params = [], options = {}) {
  return withWriteLock(() => runAffectedInner(sql, params), { op: options.op || 'db.runAffected' })
}

export async function insert(table, obj, options = {}) {
  return withWriteLock(async () => {
    const cols = Object.keys(obj)
    const placeholders = cols.map(() => '?').join(', ')
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`
    await runInner(sql, cols.map((c) => obj[c]))
    const id = obj.id || null
    if (id) return queryOne(`SELECT * FROM ${table} WHERE id = ?`, [id])
    return queryOne(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT 1`)
  }, { op: options.op || `insert.${table}` })
}

export async function updateById(table, id, obj, options = {}) {
  return withWriteLock(async () => {
    const cols = Object.keys(obj)
    const sets = cols.map((c) => `${c} = ?`).join(', ')
    const sql = `UPDATE ${table} SET ${sets} WHERE id = ?`
    await runInner(sql, [...cols.map((c) => obj[c]), id])
    return queryOne(`SELECT * FROM ${table} WHERE id = ?`, [id])
  }, { op: options.op || `update.${table}` })
}

export async function findById(table, id) {
  return queryOne(`SELECT * FROM ${table} WHERE id = ?`, [id])
}

export async function withTransaction(fn, options = {}) {
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
  }, { op: options.op || 'db.transaction' })
}

export default {
  query,
  queryOne,
  run,
  runAffected,
  insert,
  updateById,
  findById,
  withTransaction,
  withWriteLock,
  configureWriteQueue,
  getWriteQueueStats,
  WriteQueueFullError,
  PersistenceBlockedError,
}
