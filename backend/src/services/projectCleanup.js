import fs from 'node:fs'
import { query } from '../db/query.js'
import { projectDir, tmpDirOf, resolveStorageKey } from '../pipeline/context.js'

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
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      failed++
      console.error(`[Cleanup] không xoá được thư mục ${dir}:`, err.message)
    }
  }

  return { filesRemoved: removed, filesFailed: failed }
}

export default { collectProjectKeys, deleteProjectFiles }
