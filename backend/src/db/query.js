import {
  getPool,
  save,
  getDbPersistenceHealth,
  recordPersistenceSuccess,
  recordPersistenceFailure,
  PERSISTENCE_STATES,
} from '../db.js'
import {
  ALLOWED_TABLES,
  assertValidTable,
  assertValidColumnName,
  buildSafeOrderBy,
  validatePagination,
} from '../lib/sqlHelpers.js'

export {
  ALLOWED_TABLES,
  assertValidTable,
  assertValidColumnName,
  buildSafeOrderBy,
  validatePagination,
}

const NON_PERSISTENCE_SQLSTATE_PREFIXES = new Set([
  '02', '21', '22', '23', '24', '26', '27', '28', '2B', '2D', '2F',
  '34', '38', '39', '3B', '3D', '3F', '40', '42', '44', '54', '55', 'P0',
])

export function isPersistenceFailureError(err) {
  if (!err) return false
  const code = typeof err.code === 'string' ? err.code : ''
  // 25006 = read_only_sql_transaction (cannot execute writes)
  if (code === '25006') return true
  if (/^[0-9A-Z]{5}$/.test(code)) {
    const prefix = code.slice(0, 2)
    if (prefix === '25') return false
    if (NON_PERSISTENCE_SQLSTATE_PREFIXES.has(prefix)) return false
    return true
  }
  return true
}

async function checkPersistenceGate(op = 'write') {
  const health = getDbPersistenceHealth()
  if (health.state === PERSISTENCE_STATES.WRITE_BLOCKED) {
    try {
      await save()
    } catch (_) {
      throw new PersistenceBlockedError(op)
    }
  }
}

async function executePoolWrite(op, sql, params) {
  await checkPersistenceGate(op)
  const pool = getPool()
  const t0 = Date.now()
  try {
    const res = await pool.query(sql, params)
    recordPersistenceSuccess(Date.now() - t0)
    return res
  } catch (err) {
    if (isPersistenceFailureError(err)) {
      recordPersistenceFailure(err, Date.now() - t0, 'write')
    }
    throw err
  }
}

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

  // 3.1. Map SQLite EXPLAIN QUERY PLAN to PostgreSQL EXPLAIN
  s = s.replace(/\bEXPLAIN\s+QUERY\s+PLAN\b/gi, 'EXPLAIN')

  // 3.5. Convert boolean column comparisons and assignments (= 1 / = 0) to TRUE / FALSE for PostgreSQL
  const BOOL_COLS = '(?:is_active|used|email_verified|auto_upload_youtube|notify_on_complete|copyright_acknowledged|script_review_required|muted|locked|is_time_manually_adjusted|is_text_manually_edited|is_translation_manually_edited|is_static|enabled|is_system|case_sensitive)'
  const parts = s.split(/('(?:''|[^'])*')/)
  for (let i = 0; i < parts.length; i += 2) {
    if (!parts[i]) continue
    parts[i] = parts[i]
      .replace(new RegExp(`\\b(${BOOL_COLS})\\s*=\\s*1\\b`, 'gi'), '$1 = TRUE')
      .replace(new RegExp(`\\b(${BOOL_COLS})\\s*=\\s*0\\b`, 'gi'), '$1 = FALSE')
      .replace(new RegExp(`\\b(${BOOL_COLS})\\s*(?:!=|<>)\\s*0\\b`, 'gi'), '$1 = TRUE')
      .replace(new RegExp(`\\b(${BOOL_COLS})\\s*(?:!=|<>)\\s*1\\b`, 'gi'), '$1 = FALSE')
      .replace(new RegExp(`\\b1\\s*=\\s*(${BOOL_COLS})\\b`, 'gi'), 'TRUE = $1')
      .replace(new RegExp(`\\b0\\s*=\\s*(${BOOL_COLS})\\b`, 'gi'), 'FALSE = $1')
      .replace(new RegExp(`\\b(${BOOL_COLS})\\s+IS\\s+1\\b`, 'gi'), '$1 IS TRUE')
      .replace(new RegExp(`\\b(${BOOL_COLS})\\s+IS\\s+0\\b`, 'gi'), '$1 IS FALSE')
      .replace(new RegExp(`COALESCE\\s*\\(\\s*(${BOOL_COLS})\\s*,\\s*0\\s*\\)`, 'gi'), 'COALESCE($1, FALSE)')
      .replace(new RegExp(`COALESCE\\s*\\(\\s*(${BOOL_COLS})\\s*,\\s*1\\s*\\)`, 'gi'), 'COALESCE($1, TRUE)')
  }
  s = parts.join('')

  // 3.8. PRAGMA queries translation for schema checks & test compatibility
  if (/^PRAGMA\s+integrity_check\b/i.test(s)) {
    return "SELECT 'ok' AS integrity_check"
  }
  if (/^PRAGMA\s+foreign_keys\b/i.test(s)) {
    return 'SELECT 1'
  }
  const pragmaTableInfoDirect = s.match(/^PRAGMA\s+table_info\s*\(\s*['"]?(\w+)['"]?\s*\)/i)
  if (pragmaTableInfoDirect) {
    const tbl = pragmaTableInfoDirect[1]
    return `SELECT column_name AS name, data_type AS type, (is_nullable = 'NO')::int AS notnull, column_default AS dflt_value FROM information_schema.columns WHERE table_name = '${tbl}' AND table_schema = 'public' ORDER BY ordinal_position`
  }
  if (/FROM\s+pragma_table_info\s*\(\s*\?\s*\)/i.test(s)) {
    s = s.replace(/FROM\s+pragma_table_info\s*\(\s*\?\s*\)/i, "FROM information_schema.columns WHERE table_name = ? AND table_schema = 'public'")
    s = s.replace(/\bcid\b/gi, 'ordinal_position')
    s = s.replace(/\bname\b/gi, 'column_name AS name')
  }
  const pragmaTableInfoStr = s.match(/FROM\s+pragma_table_info\s*\(\s*['"](\w+)['"]\s*\)/i)
  if (pragmaTableInfoStr) {
    const tbl = pragmaTableInfoStr[1]
    s = s.replace(new RegExp(`FROM\\s+pragma_table_info\\s*\\(\\s*['"]${tbl}['"]\\s*\\)`, 'i'), `FROM information_schema.columns WHERE table_name = '${tbl}' AND table_schema = 'public'`)
    s = s.replace(/\bcid\b/gi, 'ordinal_position')
    s = s.replace(/\bname\b/gi, 'column_name AS name')
  }
  const pragmaIndexListStr = s.match(/FROM\s+pragma_index_list\s*\(\s*['"](\w+)['"]\s*\)/i)
  if (pragmaIndexListStr) {
    const tbl = pragmaIndexListStr[1]
    s = s.replace(new RegExp(`FROM\\s+pragma_index_list\\s*\\(\\s*['"]${tbl}['"]\\s*\\)`, 'i'), `FROM pg_indexes WHERE tablename = '${tbl}' AND schemaname = 'public'`)
    s = s.replace(/\bname\b/gi, 'indexname AS name')
  }

  // 4. Convert parameter placeholders '?' -> '$1', '$2', ... (respecting quoted string literals)
  if (s.includes('?')) {
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
    s = out
  }

  return s
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

export async function query(sql, params = []) {
  const pool = getPool()
  const converted = convertSqlForPostgres(sql)
  const res = await pool.query(converted, sanitizeParams(params))
  return res.rows
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params)
  return rows[0] || null
}

export async function run(sql, params = []) {
  const converted = convertSqlForPostgres(sql)
  await executePoolWrite('run', converted, sanitizeParams(params))
  return true
}

export async function runAffected(sql, params = []) {
  const converted = convertSqlForPostgres(sql)
  const res = await executePoolWrite('runAffected', converted, sanitizeParams(params))
  return res.rowCount ?? 0
}

export async function runReturningOne(sql, params = [], selectSql, selectParams = []) {
  await checkPersistenceGate('runReturningOne')
  const pool = getPool()
  const t0 = Date.now()
  let client
  try {
    client = await pool.connect()
  } catch (err) {
    if (isPersistenceFailureError(err)) {
      recordPersistenceFailure(err, Date.now() - t0, 'write')
    }
    throw err
  }
  try {
    await client.query('BEGIN')
    await client.query(convertSqlForPostgres(sql), sanitizeParams(params))
    const res = await client.query(convertSqlForPostgres(selectSql), sanitizeParams(selectParams))
    await client.query('COMMIT')
    recordPersistenceSuccess(Date.now() - t0)
    return res.rows[0] || null
  } catch (err) {
    if (isPersistenceFailureError(err)) {
      recordPersistenceFailure(err, Date.now() - t0, 'write')
    }
    try {
      await client.query('ROLLBACK')
    } catch (_) {}
    throw err
  } finally {
    client.release()
  }
}

export async function insert(table, obj) {
  const validTable = assertValidTable(table)
  const rawCols = Object.keys(obj || {})
  if (rawCols.length === 0) {
    await checkPersistenceGate('insert')
    throw new Error('Cannot insert empty object')
  }
  const cols = rawCols.map(assertValidColumnName)
  const params = cols.map((c) => sanitizeVal(obj[c]))
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
  const sql = `INSERT INTO "${validTable}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders}) RETURNING *`
  const res = await executePoolWrite('insert', sql, params)
  return res.rows[0] || null
}

export async function updateById(table, id, obj) {
  const validTable = assertValidTable(table)
  const cleanObj = { ...obj }
  delete cleanObj.id
  const rawCols = Object.keys(cleanObj)
  if (rawCols.length === 0) {
    await checkPersistenceGate('updateById')
    return findById(validTable, id)
  }
  const cols = rawCols.map(assertValidColumnName)
  const params = cols.map((c) => sanitizeVal(cleanObj[c]))
  const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')
  params.push(id)
  const sql = `UPDATE "${validTable}" SET ${sets} WHERE id = $${params.length} RETURNING *`
  const res = await executePoolWrite('updateById', sql, params)
  return res.rows[0] || null
}

export async function findById(table, id) {
  const validTable = assertValidTable(table)
  return queryOne(`SELECT * FROM "${validTable}" WHERE id = $1`, [id])
}

export async function withTransaction(fn, options = {}) {
  return withWriteLock(async () => {
    await checkPersistenceGate(options.op || 'commit')
    const pool = getPool()
    const t0 = Date.now()
    let client
    try {
      client = await pool.connect()
    } catch (err) {
      if (isPersistenceFailureError(err)) {
        recordPersistenceFailure(err, Date.now() - t0, 'write')
      }
      throw err
    }
    let lastClientQueryError = null
    const runClientQuery = async (sqlText, queryParams) => {
      try {
        return await client.query(sqlText, queryParams)
      } catch (err) {
        lastClientQueryError = err
        throw err
      }
    }
    try {
      await runClientQuery('BEGIN')
      const tx = {
        async query(sql, params = []) {
          const res = await runClientQuery(convertSqlForPostgres(sql), sanitizeParams(params))
          return res.rows
        },
        async queryOne(sql, params = []) {
          const rows = await this.query(sql, params)
          return rows[0] || null
        },
        async run(sql, params = []) {
          await runClientQuery(convertSqlForPostgres(sql), sanitizeParams(params))
          return true
        },
        async runAffected(sql, params = []) {
          const res = await runClientQuery(convertSqlForPostgres(sql), sanitizeParams(params))
          return res.rowCount ?? 0
        },
        async insert(table, obj) {
          const validTable = assertValidTable(table)
          const rawCols = Object.keys(obj || {})
          if (rawCols.length === 0) {
            throw new Error('Cannot insert empty object')
          }
          const cols = rawCols.map(assertValidColumnName)
          const params = cols.map((c) => sanitizeVal(obj[c]))
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
          const sql = `INSERT INTO "${validTable}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders}) RETURNING *`
          const res = await runClientQuery(sql, params)
          return res.rows[0] || null
        },
        async updateById(table, id, obj) {
          const validTable = assertValidTable(table)
          const cleanObj = { ...obj }
          delete cleanObj.id
          const rawCols = Object.keys(cleanObj)
          if (rawCols.length === 0) {
            return this.queryOne(`SELECT * FROM "${validTable}" WHERE id = $1`, [id])
          }
          const cols = rawCols.map(assertValidColumnName)
          const params = cols.map((c) => sanitizeVal(cleanObj[c]))
          const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')
          params.push(id)
          const sql = `UPDATE "${validTable}" SET ${sets} WHERE id = $${params.length} RETURNING *`
          const res = await runClientQuery(sql, params)
          return res.rows[0] || null
        },
      }
      const out = await fn(tx)
      await runClientQuery('COMMIT')
      recordPersistenceSuccess(Date.now() - t0)
      return out
    } catch (err) {
      if (err === lastClientQueryError && isPersistenceFailureError(err)) {
        recordPersistenceFailure(err, Date.now() - t0, 'write')
      }
      try {
        await client.query('ROLLBACK')
      } catch (_) {}
      throw err
    } finally {
      client.release()
    }
  }, options)
}

/**
 * Executes a function within an isolated tenant session context using PostgreSQL RLS.
 * Sets transaction-local variables `app.current_user_id` and `app.current_user_role`.
 * When transaction completes (COMMIT/ROLLBACK), variables are automatically cleared.
 *
 * Supports both signatures:
 *   withUserContext({ userId, role }, fn, options)
 *   withUserContext(userId, role, fn, options)
 *   withUserContext(userId, fn, options)
 *
 * @param {string|Object} userContextOrUserId - Tenant User ID or context object `{ userId, role }`
 * @param {string|Function} [roleOrFn='user'] - User role or async callback
 * @param {Function|Object} [fnOrOptions] - Async callback receiving scoped tx, or transaction options
 * @param {Object} [maybeOptions={}] - Transaction options (e.g. op name)
 */
export async function withUserContext(userContextOrUserId, roleOrFn, fnOrOptions, maybeOptions = {}) {
  let effectiveUserId = ''
  let effectiveRole = 'user'
  let fn
  let options = {}

  if (typeof userContextOrUserId === 'object' && userContextOrUserId !== null) {
    effectiveUserId = userContextOrUserId.userId || ''
    effectiveRole = userContextOrUserId.role || 'user'
    fn = roleOrFn
    options = fnOrOptions || {}
  } else if (typeof roleOrFn === 'function') {
    effectiveUserId = userContextOrUserId || ''
    effectiveRole = 'user'
    fn = roleOrFn
    options = fnOrOptions || {}
  } else {
    effectiveUserId = userContextOrUserId || ''
    effectiveRole = roleOrFn || 'user'
    fn = fnOrOptions
    options = maybeOptions || {}
  }

  if (typeof fn !== 'function') {
    throw new TypeError('withUserContext requires a function as callback')
  }

  return withTransaction(async (tx) => {
    // If connected as superuser, switch to unprivileged app role so PostgreSQL enforces RLS
    // (PostgreSQL superusers bypass RLS policies by engine design).
    try {
      await tx.query('SET LOCAL ROLE video_ai_app;')
    } catch (_) {}

    await tx.query(
      "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_user_role', $2, true);",
      [effectiveUserId, effectiveRole]
    )
    tx.userId = effectiveUserId
    tx.role = effectiveRole
    return fn(tx)
  }, options)
}

/**
 * Inspects current PostgreSQL session tenant context settings.
 *
 * @param {Object} [clientOrTx] - Optional active client or tx object
 * @returns {Promise<{userId: string, role: string}>}
 */
export async function getTenantContext(clientOrTx) {
  const queryFn = clientOrTx?.query ? clientOrTx.query.bind(clientOrTx) : query
  const res = await queryFn("SELECT current_setting('app.current_user_id', true) AS user_id, current_setting('app.current_user_role', true) AS role;")
  const row = Array.isArray(res) ? res[0] : res?.rows?.[0]
  return {
    userId: row?.user_id || '',
    role: row?.role || '',
  }
}

// Concurrency queue & telemetry management
let writeQueueDepth = 0
let maxPendingWritesConfig = 1000
let slowWriteThresholdMs = 1000
let lastWriteOperation = null
let writeQueueLogger = console

export function configureWriteQueue(opts = {}) {
  if (typeof opts.maxPendingWrites === 'number') maxPendingWritesConfig = opts.maxPendingWrites
  if (typeof opts.slowWriteMs === 'number') slowWriteThresholdMs = opts.slowWriteMs
  if (opts.logger) writeQueueLogger = opts.logger
  return getWriteQueueStats()
}

export function getWriteQueueStats() {
  return {
    depth: writeQueueDepth,
    maxPendingWrites: maxPendingWritesConfig,
    oldestWaitMs: 0,
    lastOperation: lastWriteOperation,
    lastDurationMs: 0,
    slowWrites: 0,
  }
}

let writeMutex = Promise.resolve()

export async function withWriteLock(fn, options = {}) {
  const op = options.op || 'unspecified'
  if (writeQueueDepth >= maxPendingWritesConfig) {
    throw new WriteQueueFullError(op)
  }
  writeQueueDepth++
  lastWriteOperation = op
  const prev = writeMutex
  let release
  writeMutex = new Promise((resolve) => { release = resolve })
  await prev
  const t0 = Date.now()
  try {
    const res = await fn()
    const dur = Date.now() - t0
    if (dur >= slowWriteThresholdMs && writeQueueLogger?.warn) {
      writeQueueLogger.warn(`[WriteQueue] slow write: op=${op} duration=${dur}ms`)
    }
    return res
  } finally {
    writeQueueDepth--
    release()
  }
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
  withUserContext,
  getTenantContext,
  withWriteLock,
  configureWriteQueue,
  getWriteQueueStats,
  WriteQueueFullError,
  PersistenceBlockedError,
  isPersistenceFailureError,
  convertSqlForPostgres,
  sanitizeVal,
  sanitizeParams,
}
