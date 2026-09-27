import fs from 'node:fs'
import { config } from '../config.js'
import { query, run } from '../db/query.js'
import { projectDir, tmpDirOf, resolveStorageKey } from '../pipeline/context.js'
import { isPathInside } from '../lib/safePath.js'

// Every (table, column) pair that can hold a storage_key pointing into storage/.
// projects uses `id` instead of `project_id` as its scope column.
const REF_COLUMNS = [
  ['projects', 'source_video_key', 'id'],
  ['projects', 'template_video_key', 'id'],
  ['assets', 'storage_key', 'project_id'],
  ['scenes', 'thumbnail_key', 'project_id'],
  ['audios', 'storage_key', 'project_id'],
  ['subtitles', 'storage_key', 'project_id'],
  ['outputs', 'storage_key', 'project_id'],
  ['outputs', 'thumbnail_key', 'project_id'],
]

async function collectKeysByScope(projectId, excludeProject = false) {
  const keys = new Set()
  for (const [table, col, scopeCol] of REF_COLUMNS) {
    const op = excludeProject ? '!=' : '='
    const rows = await query(
      `SELECT ${col} AS k FROM ${table} WHERE ${scopeCol} ${op} ? AND ${col} IS NOT NULL`,
      [projectId]
    )
    for (const r of rows) if (r.k) keys.add(String(r.k))
  }
  return keys
}

// Gathers every storage_key owned by the project. Must be called BEFORE the
// DB rows are deleted — afterwards the queries would find nothing.
export async function collectProjectKeys(project) {
  const keys = await collectKeysByScope(project.id)
  for (const k of [project.source_video_key, project.template_video_key]) {
    if (k) keys.add(String(k))
  }
  return keys
}

// Deletes every file on disk owned by the given project. `ownKeys` comes from
// collectProjectKeys() run before the DB wipe. Uploads still referenced by
// another project are kept until their last reference disappears.
export async function deleteProjectFiles(project, ownKeys = []) {
  const otherRefs = await collectKeysByScope(project.id, true)

  let removed = 0
  let failed = 0
  for (const key of ownKeys) {
    if (otherRefs.has(key)) continue
    const abs = resolveStorageKey(key)
    if (!abs || !fs.existsSync(abs)) continue
    try {
      fs.unlinkSync(abs)
      removed++
    } catch (err) {
      failed++
      console.error(`[Cleanup] không xoá được tệp ${key}:`, err.message)
    }
  }

  for (const dir of [projectDir(project.id), tmpDirOf(project.id)]) {
    // Trusted-root invariant: recursive deletes may only touch storage/.
    if (!isPathInside(config.storageDir, dir)) {
      failed++
      console.error(`[Cleanup] bỏ qua thư mục ngoài storage: ${dir}`)
      continue
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      failed++
      console.error(`[Cleanup] không xoá được thư mục ${dir}:`, err.message)
    }
  }

  return { filesRemoved: removed, filesFailed: failed }
}

const MAX_CLEANUP_ATTEMPTS = 10

function cleanupBackoffMs(attempts) {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60 * 1000)
}

// Idempotent: file đã gone → existsSync skip; UPDATE khoá `AND status='pending'`
// nên 2 worker song song không thể cùng đánh dấu. Không bao giờ ra ngoài
// storage (deleteProjectFiles giữ nguyên isPathInside/resolveStorageKey guard).
export async function runCleanupTask(task) {
  let keys = []
  try { keys = JSON.parse(task.keys_json || '[]') } catch (_) { keys = [] }
  keys = keys.filter((k) => typeof k === 'string' && k)
  const result = await deleteProjectFiles({ id: task.project_id }, keys)
  const attempts = (Number(task.attempts) || 0) + 1
  const done = result.filesFailed === 0
  const status = done ? 'done' : (attempts >= MAX_CLEANUP_ATTEMPTS ? 'failed' : 'pending')
  const nextAt = new Date(Date.now() + cleanupBackoffMs(attempts)).toISOString()
  await run(
    `UPDATE project_cleanup_tasks
     SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_date = ?
     WHERE id = ? AND status = 'pending'`,
    [status, attempts, nextAt, done ? null : `filesFailed=${result.filesFailed}`, new Date().toISOString(), task.id],
    { op: 'project.cleanup.task' }
  )
  if (status === 'failed') {
    console.error(`[Cleanup] ALERT: project_cleanup_tasks id=${task.id} project=${task.project_id} FAILED sau ${attempts} lần retry — cần can thiệp thủ công`)
  }
  return { status, attempts, ...result }
}

export async function sweepProjectCleanupTasks({ limit = 10 } = {}) {
  const now = new Date().toISOString()
  const due = await query(
    `SELECT * FROM project_cleanup_tasks WHERE status = 'pending' AND next_attempt_at <= ?
     ORDER BY next_attempt_at LIMIT ?`,
    [now, limit]
  )
  let processed = 0
  for (const task of due) {
    try {
      await runCleanupTask(task)
      processed++
    } catch (e) {
      console.error(`[Cleanup] task ${task.id} retry lỗi:`, e?.message || e)
    }
  }
  return { processed }
}

// Lightweight observability for the cleanup outbox. Counts only — never
// selects keys_json (no storage-key material exposed through stats).
export async function getCleanupStats() {
  try {
    const pendingRows = await query(
      `SELECT COUNT(*) AS cnt, MIN(created_date) AS oldest FROM project_cleanup_tasks WHERE status = 'pending'`
    )
    const failedRows = await query(
      `SELECT COUNT(*) AS cnt, MAX(updated_date) AS lastFailure FROM project_cleanup_tasks WHERE status = 'failed'`
    )
    const pending = Number(pendingRows?.[0]?.cnt || 0)
    const failed = Number(failedRows?.[0]?.cnt || 0)
    const oldest = pendingRows?.[0]?.oldest
    const oldestPendingAgeMs = oldest ? Math.max(0, Date.now() - new Date(oldest).getTime()) : 0
    const lastFailureAt = failedRows?.[0]?.lastFailure || null
    return { pending, failed, oldestPendingAgeMs, lastFailureAt }
  } catch (_) {
    return { pending: 0, failed: 0, oldestPendingAgeMs: 0, lastFailureAt: null }
  }
}

export default { collectProjectKeys, deleteProjectFiles, runCleanupTask, sweepProjectCleanupTasks, getCleanupStats }
