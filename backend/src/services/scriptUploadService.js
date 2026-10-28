import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { config } from '../config.js'
import { query, queryOne, insert, run, runAffected } from '../db/query.js'
import { isPathInside } from '../lib/safePath.js'

// Private staged script uploads. Files live under storage/script-uploads/ and
// are NOT served by the /storage allowlist; only owner-checked routes read them.

const SCRIPT_UPLOAD_ROOT = path.join(config.storageDir, 'script-uploads')

function uploadDir(userId) {
  const segment = String(userId || '')
  if (!segment || segment === '.' || segment === '..' || /[\\/]/.test(segment)) {
    throw new Error('Invalid script upload owner')
  }
  return path.join(SCRIPT_UPLOAD_ROOT, segment)
}

export function scriptUploadStorageKey(userId, uploadId) {
  return `script-uploads/${userId}/${uploadId}.txt`
}

export function resolveScriptUploadPath(storageKey) {
  if (!storageKey) return null
  const abs = path.resolve(config.storageDir, String(storageKey))
  if (!isPathInside(SCRIPT_UPLOAD_ROOT, abs)) return null
  return abs
}

export async function createScriptUpload({ userId, filename, mime, text, sha256, byteSize, charCount }) {
  const id = uuidv4()
  const storageKey = scriptUploadStorageKey(userId, id)
  const dir = uploadDir(userId)
  fs.mkdirSync(dir, { recursive: true })
  const abs = path.join(dir, `${id}.txt`)
  fs.writeFileSync(abs, text, 'utf8')
  const createdDate = new Date().toISOString()
  const row = await insert('script_uploads', {
    id,
    user_id: userId,
    project_id: null,
    filename,
    mime: mime || null,
    byte_size: byteSize,
    char_count: charCount,
    sha256,
    storage_key: storageKey,
    status: 'ready',
    created_date: createdDate,
    consumed_at: null,
  })
  return row
}

export async function getScriptUploadForUser(uploadId, userId) {
  return queryOne('SELECT * FROM script_uploads WHERE id = ? AND user_id = ?', [uploadId, userId])
}

export function readScriptUploadText(upload) {
  const abs = resolveScriptUploadPath(upload?.storage_key)
  if (!abs || !fs.existsSync(abs)) return null
  return fs.readFileSync(abs, 'utf8')
}

// Atomic reservation: only one project can consume an upload.
export async function reserveScriptUpload(uploadId, userId, projectId) {
  const changed = await runAffected(
    `UPDATE script_uploads SET project_id = ?, status = 'consumed', consumed_at = ?
     WHERE id = ? AND user_id = ? AND project_id IS NULL`,
    [projectId, new Date().toISOString(), uploadId, userId],
    { op: 'script_upload.reserve' }
  )
  return changed === 1
}

export async function releaseScriptUpload(uploadId, userId) {
  await run(
    `UPDATE script_uploads SET project_id = NULL, status = 'ready', consumed_at = NULL
     WHERE id = ? AND user_id = ?`,
    [uploadId, userId],
    { op: 'script_upload.release' }
  )
}

export async function deleteScriptUpload(uploadId) {
  const row = await queryOne('SELECT storage_key FROM script_uploads WHERE id = ?', [uploadId])
  await run('DELETE FROM script_uploads WHERE id = ?', [uploadId], { op: 'script_upload.delete' })
  if (row?.storage_key) {
    const abs = resolveScriptUploadPath(row.storage_key)
    if (abs) { try { fs.unlinkSync(abs) } catch (_) {} }
  }
}

export async function cleanupExpiredUploads({ olderThanHours = 24 } = {}) {
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString()
  const rows = await query(
    `SELECT id, storage_key FROM script_uploads
     WHERE status = 'ready' AND project_id IS NULL AND (created_date IS NULL OR created_date < ?)
     LIMIT 100`,
    [cutoff]
  )
  let removed = 0
  for (const row of rows) {
    await deleteScriptUpload(row.id)
    removed++
  }
  return { removed }
}

export default {
  scriptUploadStorageKey,
  resolveScriptUploadPath,
  createScriptUpload,
  getScriptUploadForUser,
  readScriptUploadText,
  reserveScriptUpload,
  releaseScriptUpload,
  deleteScriptUpload,
  cleanupExpiredUploads,
}
