import pg from 'pg'
import { assertDatabaseSecrets, redactSensitiveString } from './config.js'

const { Pool: PgPool, types: pgTypes } = pg

// Configure pg type parsers for complete backward compatibility
pgTypes.setTypeParser(114, (val) => val) // json -> raw string for application JSON.parse compatibility
pgTypes.setTypeParser(3802, (val) => val) // jsonb -> raw string
pgTypes.setTypeParser(20, (val) => Number(val)) // int8 / bigint / count(*) -> number
pgTypes.setTypeParser(1700, (val) => Number(val)) // numeric / decimal -> number

export function isPostgresMode() {
  return true
}

let pgPool = null

export function getDatabasePoolConfig() {
  const connectionString = process.env.DATABASE_URL
  const ssl = process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
    : false

  const baseConfig = connectionString
    ? { connectionString }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 5433),
        user: process.env.DB_USER || 'video_ai_user',
        password: process.env.DB_PASSWORD || 'VideoAI_Secure_Db_2026!',
        database: process.env.DB_NAME || 'video_ai',
      }

  return {
    ...baseConfig,
    ...(ssl ? { ssl } : {}),
    max: Number(process.env.DB_POOL_MAX || 20),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 10000),
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000),
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 30000),
    query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS || 30000),
    allowExitOnIdle: true,
  }
}

export function getPool() {
  if (!pgPool) {
    assertDatabaseSecrets({
      nodeEnv: process.env.NODE_ENV,
      dbPassword: process.env.DB_PASSWORD,
      databaseUrl: process.env.DATABASE_URL,
      strictSecrets: process.env.STRICT_SECRETS === 'true',
    })
    const poolConfig = getDatabasePoolConfig()
    pgPool = new PgPool(poolConfig)
    pgPool.on('error', (err) => {
      console.error('[PostgreSQL Pool Error]', redactSensitiveString(err?.message || err))
    })
  }
  return pgPool
}

export async function closePool() {
  if (pgPool) {
    const p = pgPool
    pgPool = null
    await p.end()
  }
}

export const PERSISTENCE_STATES = Object.freeze({
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  WRITE_BLOCKED: 'WRITE_BLOCKED',
})

let consecutiveSaveFailures = 0
let lastSaveError = null
let lastSuccessfulSaveAt = new Date().toISOString()
let lastSaveDurationMs = 0
let lastFailureSource = null // 'write' | 'probe' | null

function maxSaveFailuresLimit() {
  const v = Number(process.env.DB_MAX_SAVE_FAILURES)
  return Number.isInteger(v) && v >= 1 ? v : 5
}

function formatPersistenceError(err) {
  const raw = err?.message || err?.errors?.[0]?.message || err?.code || String(err)
  return redactSensitiveString(raw || 'Database persistence error')
}

export function recordPersistenceSuccess(durationMs = 0) {
  consecutiveSaveFailures = 0
  lastSaveError = null
  lastFailureSource = null
  lastSaveDurationMs = Math.max(0, Math.round(Number(durationMs) || 0))
  lastSuccessfulSaveAt = new Date().toISOString()
}

export function recordPersistenceFailure(err, durationMs = 0, source = 'write') {
  consecutiveSaveFailures++
  lastSaveError = formatPersistenceError(err)
  lastFailureSource = source
  lastSaveDurationMs = Math.max(0, Math.round(Number(durationMs) || 0))
}

export function getDbPersistenceStats() {
  return {
    engine: 'postgresql',
    lastSaveAt: lastSuccessfulSaveAt,
    lastSaveDurationMs,
    lastSaveError,
    writerLock: false,
  }
}

export function getDbPersistenceHealth() {
  const max = maxSaveFailuresLimit()
  let state = PERSISTENCE_STATES.HEALTHY
  if (consecutiveSaveFailures >= max) {
    state = PERSISTENCE_STATES.WRITE_BLOCKED
  } else if (consecutiveSaveFailures > 0) {
    state = PERSISTENCE_STATES.DEGRADED
  }
  return {
    engine: 'postgresql',
    state,
    consecutiveSaveFailures,
    lastSaveError,
    lastSuccessfulSaveAt,
    lastSaveDurationMs,
    maxSaveFailures: max,
  }
}

export async function save() {
  const t0 = Date.now()
  try {
    const pool = getPool()
    await pool.query('SELECT 1')
    recordPersistenceSuccess(Date.now() - t0)
    return true
  } catch (err) {
    recordPersistenceFailure(err, Date.now() - t0, 'probe')
    throw err
  }
}

export async function probeDatabaseHealth() {
  const t0 = Date.now()
  try {
    const pool = getPool()
    await pool.query('SELECT 1')
    // Preserve DEGRADED state caused by failed writes until a write or explicit save()
    // succeeds, while allowing recovery from probe outages or WRITE_BLOCKED.
    if (
      consecutiveSaveFailures === 0 ||
      lastFailureSource === 'probe' ||
      consecutiveSaveFailures >= maxSaveFailuresLimit()
    ) {
      recordPersistenceSuccess(Date.now() - t0)
    }
  } catch (err) {
    recordPersistenceFailure(err, Date.now() - t0, 'probe')
  }
  return getDbPersistenceHealth()
}

let dbInitPromise = null

export async function getDb() {
  const pool = getPool()
  if (!dbInitPromise) {
    dbInitPromise = pool.query('SELECT 1').then(() => pool).catch((err) => {
      dbInitPromise = null
      throw err
    })
  }
  return await dbInitPromise
}

// Inert backward compatibility stubs
export function releaseWriterLock() {}
export function captureMemorySnapshot() {
  return null
}
export function persistOrRollback() {}
export function restoreMemorySnapshot() {
  return null
}

process.once('exit', () => {
  closePool().catch(() => {})
})
process.once('SIGINT', () => {
  closePool().catch(() => {})
  process.exit(130)
})
process.once('SIGTERM', () => {
  closePool().catch(() => {})
  process.exit(143)
})

export async function verifyDatabaseConstraints() {
  const pool = getPool()
  const res = await pool.query(`
    SELECT conname, contype, conrelid::regclass AS table_name
    FROM pg_constraint
    WHERE contype IN ('f', 'p', 'u')
      AND connamespace = 'public'::regnamespace
    LIMIT 20;
  `)
  return {
    constraintsActive: res.rows.length > 0,
    sampleCount: res.rows.length,
  }
}

export async function verifyDatabaseBackupReadiness() {
  const pool = getPool()
  const res = await pool.query('SELECT pg_is_in_recovery() AS in_recovery, current_database() AS current_db;')
  return {
    ready: true,
    inRecovery: Boolean(res.rows[0]?.in_recovery),
    database: res.rows[0]?.current_db || 'unknown',
  }
}

export default {
  isPostgresMode,
  getPool,
  getDatabasePoolConfig,
  closePool,
  verifyDatabaseConstraints,
  verifyDatabaseBackupReadiness,
  getDb,
  getDbPersistenceStats,
  getDbPersistenceHealth,
  probeDatabaseHealth,
  recordPersistenceSuccess,
  recordPersistenceFailure,
  PERSISTENCE_STATES,
  releaseWriterLock,
  save,
  captureMemorySnapshot,
  persistOrRollback,
  restoreMemorySnapshot,
}
