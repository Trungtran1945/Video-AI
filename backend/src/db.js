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
let db = null
let dbInitPromise = null
let writerLockFd = null
let writerLockHeartbeat = null
let lastSaveAt = null
let lastSaveDurationMs = 0
let lastSaveError = null

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

export async function getDb() {
  if (db) return db
  if (dbInitPromise) return dbInitPromise
  dbInitPromise = (async () => {
    acquireWriterLock()
    try {
      recoverPersistedDatabase()
      const SQL = await initSqlJs()
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
  } catch (error) {
    lastSaveError = error
    try { fs.rmSync(tempPath, { force: true }) } catch (_) {}
    throw error
  }
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
