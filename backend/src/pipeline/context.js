import path from 'path'
import fs from 'node:fs'
import { config } from '../config.js'
import { getPool } from '../db.js'
import { queryOne, run, sanitizeVal } from '../db/query.js'
import { resolveSafePath, isPathInside, UnsafeStoragePathError } from '../lib/safePath.js'
import { normalizeJobStatus } from '../lib/projectStatus.js'

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

export { createJobStagingContext, stageSourceMedia } from './mediaStaging.js'

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

export function parseParams(raw) {
  return parseJsonSafe(raw, {})
}

export function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  async function lane() {
    while (next < items.length) {
      const idx = next++
      results[idx] = await worker(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
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
  if (!objects || !objects.length) return
  const pool = getPool()
  const cols = Object.keys(objects[0])
  const params = []
  const rowPlaceholders = objects.map((obj) => {
    const rowSlots = cols.map((c) => {
      params.push(sanitizeVal(obj[c]))
      return `$${params.length}`
    })
    return `(${rowSlots.join(', ')})`
  })
  const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES ${rowPlaceholders.join(', ')}`
  await pool.query(sql, params)
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

export const round2 = (n) => Math.round(n * 100) / 100
export const round3 = (n) => Math.round(n * 1000) / 1000

export const ASPECT_DIMS = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:3': [1440, 1080],
  '3:4': [1080, 1440],
  '4:5': [1080, 1350],
  '21:9': [2560, 1080],
}

export function toEven(v) {
  const n = Math.round(Number(v) || 0)
  return Math.max(2, Math.floor(n / 2) * 2)
}

export function dimsForAspect(aspectRatio, customDims = null) {
  const rawKey = String(aspectRatio || '').trim()
  const key = rawKey.toLowerCase()
  if ((key === 'custom' || !key) && customDims) {
    const cw = Number(customDims.width || customDims.w)
    const ch = Number(customDims.height || customDims.h)
    if (cw > 0 && ch > 0) {
      return { width: toEven(cw), height: toEven(ch) }
    }
  }
  const dims = ASPECT_DIMS[rawKey] || ASPECT_DIMS[key]
  if (dims) return { width: toEven(dims[0]), height: toEven(dims[1]) }
  const m = key.match(/^(\d+)\s*[:xX]\s*(\d+)$/)
  if (m) {
    const w = Number(m[1])
    const h = Number(m[2])
    if (w > 0 && h > 0) {
      if (w >= 100 && h >= 100) {
        return { width: toEven(w), height: toEven(h) }
      }
      const scale = 1080 / Math.min(w, h)
      return { width: toEven(w * scale), height: toEven(h * scale) }
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
    if (normalizeJobStatus(job.status) === 'success') continue
    if (job.status === 'retry' && job.next_retry_at && new Date(job.next_retry_at).getTime() > now) {
      return { type, waiting: true, nextRetryAt: job.next_retry_at }
    }
    return { type, waiting: false, nextRetryAt: null }
  }
  return { type: null, waiting: false, nextRetryAt: null }
}
