import path from 'path'
import fs from 'node:fs'
import { config } from '../config.js'
import { getDb, save } from '../db.js'
import { queryOne, run, withWriteLock } from '../db/query.js'
import { resolveSafePath, isPathInside, UnsafeStoragePathError } from '../lib/safePath.js'

// Storage sub-paths are always storage/<bucket>/<single-segment-id>.
// Rejecting separators/'..' here keeps every helper below (projectDir,
// tmpDirOf, and the recursive deletes built on them) inside the storage root.
function storageChild(bucket, id) {
  const segment = String(id ?? '')
  if (!segment || segment === '.' || segment === '..' || /[\\/]/.test(segment) || path.isAbsolute(segment)) {
    throw new UnsafeStoragePathError(`Invalid storage path segment for ${bucket}`)
  }
  return path.join(config.storageDir, bucket, segment)
}

export function projectDir(projectId) {
  return storageChild('projects', projectId)
}

export function tmpDirOf(projectId) {
  return storageChild('tmp', projectId)
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// Storage key → absolute path. Rejects traversal (../), absolute external
// paths and sibling-prefix escapes (storage_backup vs storage) — returns null
// instead of a path outside the storage root.
export function resolveStorageKey(storageKey) {
  if (!storageKey) return null
  return resolveSafePath(config.storageDir, storageKey)
}

// Absolute path → storage key. Throws UnsafeStoragePathError for any path
// outside the storage root — never silently produces a '../' key.
export function toStorageKey(absPath) {
  const root = path.resolve(config.storageDir)
  const absolute = path.resolve(String(absPath ?? ''))
  if (!isPathInside(root, absolute)) {
    throw new UnsafeStoragePathError('Path is outside the storage root')
  }
  return path.relative(root, absolute).split(path.sep).join('/')
}

export function requireSourceFile(storageKey, label = 'Tệp nguồn') {
  const abs = resolveStorageKey(storageKey)
  if (!abs || !fs.existsSync(abs)) {
    throw new Error(`${label} không tồn tại trong kho lưu trữ: ${storageKey}. Hãy upload lại tệp rồi retry.`)
  }
  return abs
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (_) {
    return fallback
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(data))
  return file
}

export function parseJsonSafe(text, fallback = null) {
  if (!text) return fallback
  try {
    return JSON.parse(text)
  } catch (_) {
    return fallback
  }
}

export function extractJsonBlock(text) {
  if (!text) return null
  let t = String(text).trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(t.slice(start, end + 1))
  } catch (_) {
    return null
  }
}

export async function getUserSettings(userId) {
  let s = await queryOne('SELECT * FROM settings WHERE user_id = ?', [userId])
  if (!s) {
    await run('INSERT OR IGNORE INTO settings (user_id) VALUES (?)', [userId])
    s = await queryOne('SELECT * FROM settings WHERE user_id = ?', [userId])
  }
  return s
}

export async function insertMany(table, objects) {
  if (!objects.length) return
  return withWriteLock(async () => {
    const db = await getDb()
    const cols = Object.keys(objects[0])
    const placeholderRow = `(${cols.map(() => '?').join(',')})`
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${objects.map(() => placeholderRow).join(',')}`
    const params = []
    for (const obj of objects) {
      for (const c of cols) params.push(obj[c] ?? null)
    }
    db.run(sql, params)
    save()
  })
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

export const round2 = (n) => Math.round(n * 100) / 100
export const round3 = (n) => Math.round(n * 1000) / 1000

const ASPECT_DIMS = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '4:3': [1440, 1080],
  '1:1': [1080, 1080],
}

export function dimsForAspect(aspectRatio) {
  const key = String(aspectRatio || '').trim()
  const dims = ASPECT_DIMS[key]
  if (dims) return { width: dims[0], height: dims[1] }
  const m = key.match(/^(\d+)\s*[:xX]\s*(\d+)$/)
  if (m) {
    const w = Number(m[1])
    const h = Number(m[2])
    if (w > 0 && h > 0) {
      const scale = 1080 / Math.min(w, h)
      const even = (v) => Math.max(2, Math.round((v * scale) / 2) * 2)
      return { width: even(w), height: even(h) }
    }
  }
  return { width: 1080, height: 1920 }
}

export function isImageAsset(asset) {
  if (String(asset.kind || '').toLowerCase() === 'image') return true
  return /\.(jpe?g|png|webp|bmp|gif)$/i.test(asset.storage_key || '')
}

// Resume order for pipeline retry/regenerate (pure, testable).
// Returns the earliest stage that still needs work, following STAGE ORDER —
// never created_date (ties are undefined) and never skipping pending/retry
// predecessors. Running a downstream stage while predecessors are incomplete
// can only reproduce BLOCK_RENDER loops (e.g. dub.render while dub.ttsAlign
// is pending → "12 segment chưa có TTS audio" forever).
//
// Returns { type: null, waiting: false } when every stage succeeded,
// { type, waiting: true, nextRetryAt } when the earliest incomplete stage is
// a rate-limit cooldown that has not elapsed yet (caller must halt, not skip).
export function firstRunnableStage(order, jobs, now = Date.now()) {
  const flat = (order || []).flat()
  const byType = new Map((jobs || []).map((j) => [j.type, j]))
  for (const type of flat) {
    const job = byType.get(type)
    if (!job) return { type, waiting: false, nextRetryAt: null }
    if (job.status === 'success') continue
    if (job.status === 'retry' && job.next_retry_at && new Date(job.next_retry_at).getTime() > now) {
      return { type, waiting: true, nextRetryAt: job.next_retry_at }
    }
    return { type, waiting: false, nextRetryAt: null }
  }
  return { type: null, waiting: false, nextRetryAt: null }
}
