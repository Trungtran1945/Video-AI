import initSqlJs from 'sql.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function resolveDbPath() {
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH)
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl?.startsWith('file:')) return path.resolve(databaseUrl.slice(5))
  return path.join(__dirname, '..', 'data.db')
}

const DB_PATH = resolveDbPath()
const DB_BACKUP_PATH = `${DB_PATH}.backup`
const WRITER_LOCK_PATH = `${DB_PATH}.writer.lock`
const WRITER_LOCK_HEARTBEAT_MS = 5000
const FOREIGN_LOCK_STALE_MS = 5 * 60 * 1000
const MAX_SAVE_FAILURES = (() => {
  const value = Number(process.env.DB_MAX_SAVE_FAILURES)
  return Number.isInteger(value) && value >= 1 ? value : 5
})()
export const PERSISTENCE_STATES = Object.freeze({
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  WRITE_BLOCKED: 'WRITE_BLOCKED',
})
let db = null
let sqlModule = null
let dbInitPromise = null
let writerLockFd = null
let writerLockHeartbeat = null
let lastSaveAt = null
let lastSaveDurationMs = 0
let lastSaveError = null
let lastSuccessfulSaveAt = null
let consecutiveSaveFailures = 0
let persistenceState = PERSISTENCE_STATES.HEALTHY

function readWriterLock() {
  try {
    return JSON.parse(fs.readFileSync(WRITER_LOCK_PATH, 'utf8'))
  } catch (_) {
    return null
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function lockIsOld(minAgeMs = 1000) {
  try {
    return Date.now() - fs.statSync(WRITER_LOCK_PATH).mtimeMs > minAgeMs
  } catch (_) {
    return false
  }
}

function startWriterLockHeartbeat() {
  if (writerLockHeartbeat) return
  writerLockHeartbeat = setInterval(() => {
    try {
      const now = new Date()
      fs.utimesSync(WRITER_LOCK_PATH, now, now)
    } catch (_) {}
  }, WRITER_LOCK_HEARTBEAT_MS)
  if (typeof writerLockHeartbeat.unref === 'function') writerLockHeartbeat.unref()
}

function recoverPersistedDatabase() {
  const hasDatabase = fs.existsSync(DB_PATH)
  const hasBackup = fs.existsSync(DB_BACKUP_PATH)
  if (!hasDatabase && hasBackup) {
    fs.renameSync(DB_BACKUP_PATH, DB_PATH)
  } else if (hasDatabase && hasBackup) {
    fs.rmSync(DB_BACKUP_PATH, { force: true })
  }
}

function replacePersistedDatabase(tempPath) {
  if (process.platform !== 'win32') {
    try {
      fs.renameSync(tempPath, DB_PATH)
      return
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error
    }
  }

  if (fs.existsSync(DB_BACKUP_PATH)) fs.rmSync(DB_BACKUP_PATH, { force: true })
  const hadDatabase = fs.existsSync(DB_PATH)
  if (hadDatabase) fs.renameSync(DB_PATH, DB_BACKUP_PATH)
  try {
    fs.renameSync(tempPath, DB_PATH)
  } catch (error) {
    if (!fs.existsSync(DB_PATH) && fs.existsSync(DB_BACKUP_PATH)) {
      try { fs.renameSync(DB_BACKUP_PATH, DB_PATH) } catch (_) {}
    }
    throw error
  }
  if (fs.existsSync(DB_BACKUP_PATH)) {
    try { fs.rmSync(DB_BACKUP_PATH, { force: true }) } catch (_) {}
  }
}

function acquireWriterLock() {
  const mode = String(process.env.INSTANCE_MODE || 'single').toLowerCase()
  if (mode !== 'single') {
    throw new Error(`[DB] sql.js supports INSTANCE_MODE=single only (got ${mode})`)
  }
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writerLockFd = fs.openSync(WRITER_LOCK_PATH, 'wx')
      fs.writeFileSync(writerLockFd, JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() }))
      startWriterLockHeartbeat()
      return
    } catch (error) {
      if (writerLockFd !== null) {
        try { fs.closeSync(writerLockFd) } catch (_) {}
        try { fs.rmSync(WRITER_LOCK_PATH, { force: true }) } catch (_) {}
        writerLockFd = null
      }
      if (error?.code !== 'EEXIST') throw error
      const owner = readWriterLock()
      const sameHost = owner?.hostname === os.hostname()
      const oldEnough = owner?.startedAt && Date.now() - new Date(owner.startedAt).getTime() > 1000
      const foreignStale = owner && !sameHost && lockIsOld(FOREIGN_LOCK_STALE_MS)
      if ((!owner && lockIsOld()) || foreignStale || (sameHost && oldEnough && !processIsAlive(owner.pid))) {
        try { fs.rmSync(WRITER_LOCK_PATH, { force: true }) } catch (_) {}
        continue
      }
      throw new Error(`[DB] another sql.js writer owns ${DB_PATH}; INSTANCE_MODE=single is required`)
    }
  }
  throw new Error(`[DB] unable to acquire sql.js writer lock for ${DB_PATH}`)
}

export function releaseWriterLock() {
  if (writerLockHeartbeat) {
    clearInterval(writerLockHeartbeat)
    writerLockHeartbeat = null
  }
  if (writerLockFd === null) return
  try { fs.closeSync(writerLockFd) } catch (_) {}
  writerLockFd = null
  const owner = readWriterLock()
  if (owner?.pid === process.pid && owner?.hostname === os.hostname()) {
    try { fs.rmSync(WRITER_LOCK_PATH, { force: true }) } catch (_) {}
  }
}

export function getDbPersistenceStats() {
  return {
    lastSaveAt,
    lastSaveDurationMs,
    lastSaveError: lastSaveError ? (lastSaveError.name || 'save_failed') : null,
    writerLock: writerLockFd !== null,
  }
}

// Persistence health: HEALTHY → DEGRADED (some consecutive save failures)
// → WRITE_BLOCKED (threshold reached; mutations must be rejected).
// Any successful save resets the counter and returns to HEALTHY.
export function getDbPersistenceHealth() {
  return {
    state: persistenceState,
    consecutiveSaveFailures,
    lastSaveError: lastSaveError ? (lastSaveError.name || 'save_failed') : null,
    lastSuccessfulSaveAt,
    lastSaveDurationMs,
    maxSaveFailures: MAX_SAVE_FAILURES,
  }
}

export async function getDb() {
  if (db) return db
  if (dbInitPromise) return dbInitPromise
  dbInitPromise = (async () => {
    acquireWriterLock()
    try {
      recoverPersistedDatabase()
      const SQL = await initSqlJs()
      sqlModule = SQL
      if (fs.existsSync(DB_PATH)) {
        const buffer = fs.readFileSync(DB_PATH)
        db = new SQL.Database(buffer)
      } else {
        db = new SQL.Database()
      }
      db.run('PRAGMA foreign_keys = ON')
      return db
    } catch (error) {
      releaseWriterLock()
      throw error
    }
  })()
  try {
    return await dbInitPromise
  } finally {
    dbInitPromise = null
  }
}

export function save() {
  if (!db) return
  const startedAt = Date.now()
  const data = db.export()
  const buffer = Buffer.from(data)
  const tempPath = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tempPath, buffer, { flag: 'wx' })
    replacePersistedDatabase(tempPath)
    lastSaveAt = new Date().toISOString()
    lastSaveDurationMs = Date.now() - startedAt
    lastSaveError = null
    lastSuccessfulSaveAt = lastSaveAt
    consecutiveSaveFailures = 0
    if (persistenceState !== PERSISTENCE_STATES.HEALTHY) {
      console.warn(`[DB] persistence recovered → ${PERSISTENCE_STATES.HEALTHY}`)
    }
    persistenceState = PERSISTENCE_STATES.HEALTHY
  } catch (error) {
    lastSaveError = error
    consecutiveSaveFailures += 1
    persistenceState = consecutiveSaveFailures >= MAX_SAVE_FAILURES
      ? PERSISTENCE_STATES.WRITE_BLOCKED
      : PERSISTENCE_STATES.DEGRADED
    if (persistenceState === PERSISTENCE_STATES.WRITE_BLOCKED && consecutiveSaveFailures === MAX_SAVE_FAILURES) {
      console.error(`[DB] persistence WRITE_BLOCKED after ${consecutiveSaveFailures} consecutive save failures`)
    }
    try { fs.rmSync(tempPath, { force: true }) } catch (_) {}
    throw error
  }
}

// ── Application persistence boundary ─────────────────────────────────────
// sql.js keeps the whole database in memory and save() writes that memory
// image to disk, so every write has TWO steps: (1) the in-memory mutation,
// (2) persistence. Callers may only observe a write as committed when BOTH
// succeeded — otherwise a rejected write would keep living in memory and a
// later (recovery/probe) save() would silently persist it, turning an API
// failure into a duplicate on retry.
//
//   const snapshot = captureMemorySnapshot()   // pre-mutation memory image
//   db.run(...) // in-memory mutation
//   persistOrRollback(snapshot)                 // save() or restore + rethrow
//
// On save failure the in-memory database is rebuilt from the snapshot, so:
//   memory = BEFORE the mutation, disk = BEFORE the mutation, API = ERROR.
// Health accounting (HEALTHY/DEGRADED/WRITE_BLOCKED, DB_MAX_SAVE_FAILURES)
// lives entirely inside save() and is untouched by the rollback.
export function captureMemorySnapshot() {
  if (!db) throw new Error('[DB] database is not initialized')
  return db.export()
}

export function persistOrRollback(snapshot) {
  try {
    save()
  } catch (error) {
    try {
      restoreMemorySnapshot(snapshot)
    } catch (restoreError) {
      console.error('[DB] CRITICAL: memory rollback after failed save did not apply:', restoreError?.message || restoreError)
    }
    throw error
  }
}

// Rebuild the in-memory database from a snapshot taken before a mutation.
// The old handle is closed so nothing can keep reading the discarded state.
export function restoreMemorySnapshot(snapshot) {
  if (!sqlModule) throw new Error('[DB] sql.js module is not initialized')
  const previous = db
  db = new sqlModule.Database(snapshot)
  db.run('PRAGMA foreign_keys = ON')
  if (previous && previous !== db) {
    try { previous.close() } catch (_) {}
  }
  return db
}

process.once('exit', releaseWriterLock)
process.once('SIGINT', () => {
  releaseWriterLock()
  process.exit(130)
})
process.once('SIGTERM', () => {
  releaseWriterLock()
  process.exit(143)
})
