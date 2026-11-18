import pg from 'pg'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

export function getPool() {
  if (!pgPool) {
    const connectionString = process.env.DATABASE_URL
    const poolConfig = connectionString
      ? { connectionString }
      : {
          host: process.env.DB_HOST || 'localhost',
          port: Number(process.env.DB_PORT || 5433),
          user: process.env.DB_USER || 'video_ai_user',
          password: process.env.DB_PASSWORD || 'VideoAI_Secure_Db_2026!',
          database: process.env.DB_NAME || 'video_ai',
        }
    pgPool = new PgPool({
      ...poolConfig,
      max: Number(process.env.DB_POOL_MAX || 20),
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
      allowExitOnIdle: true,
    })
    pgPool.on('error', (err) => {
      console.error('[PostgreSQL Pool Error]', err?.message || err)
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

export function getDbPersistenceStats() {
  return {
    engine: 'postgresql',
    lastSaveAt: new Date().toISOString(),
    lastSaveDurationMs: 0,
    lastSaveError: null,
    writerLock: false,
  }
}

let consecutiveSaveFailures = 0
let lastSaveError = null
let lastSuccessfulSaveAt = new Date().toISOString()

export function getDbPersistenceHealth() {
  const max = (() => {
    const v = Number(process.env.DB_MAX_SAVE_FAILURES)
    return Number.isInteger(v) && v >= 1 ? v : 5
  })()
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
    lastSaveDurationMs: 0,
    maxSaveFailures: max,
  }
}

export function save() {
  try {
    fs.writeFileSync(path.join(os.tmpdir(), '.vidai_db_probe'), 'ok')
    consecutiveSaveFailures = 0
    lastSaveError = null
    lastSuccessfulSaveAt = new Date().toISOString()
  } catch (err) {
    consecutiveSaveFailures++
    lastSaveError = err?.message || String(err)
    throw err
  }
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

export default {
  isPostgresMode,
  getPool,
  closePool,
  getDb,
  getDbPersistenceStats,
  getDbPersistenceHealth,
  PERSISTENCE_STATES,
  releaseWriterLock,
  save,
  captureMemorySnapshot,
  persistOrRollback,
  restoreMemorySnapshot,
}
