import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, run, withTransaction } from '../db/query.js'
import { resolveStorageKey } from '../pipeline/context.js'
import { outputIsStale } from './outputService.js'
import { getAccountRow, isYoutubeConfigured, YoutubeError } from './youtubeOAuthService.js'

// YouTube publish outbox. One row per output; the row is reused on retry so a
// failed/cancelled publish never forks history. Validation lives here so both
// the API and the DB worker share exactly the same rules.

export const YOUTUBE_PRIVACY = ['private', 'unlisted', 'public']
export const YOUTUBE_ACTIVE_STATUSES = ['queued', 'uploading', 'processing']
export const YOUTUBE_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled']

const TITLE_MAX = 100
const DESCRIPTION_MAX = 5000
const TAG_MAX_COUNT = 30
const TAG_MAX_LENGTH = 100
const TAGS_TOTAL_MAX = 500
const DEFAULT_CATEGORY_ID = '22'

export class YoutubePublishError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message || code)
    this.name = 'YoutubePublishError'
    this.code = code
    this.statusCode = statusCode
  }
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function validatePublishPayload(body) {
  const input = body && typeof body === 'object' ? body : {}

  const title = trimString(input.title)
  if (!title) throw new YoutubePublishError('YOUTUBE_TITLE_REQUIRED', 'Tiêu đề video là bắt buộc', 400)
  if (title.length > TITLE_MAX) {
    throw new YoutubePublishError('YOUTUBE_TITLE_TOO_LONG', `Tiêu đề tối đa ${TITLE_MAX} ký tự`, 400)
  }

  const description = input.description === undefined || input.description === null
    ? ''
    : String(input.description)
  if (description.length > DESCRIPTION_MAX) {
    throw new YoutubePublishError('YOUTUBE_DESCRIPTION_TOO_LONG', `Mô tả tối đa ${DESCRIPTION_MAX} ký tự`, 400)
  }

  const rawTags = input.tags === undefined || input.tags === null ? [] : input.tags
  if (!Array.isArray(rawTags)) {
    throw new YoutubePublishError('YOUTUBE_TAGS_INVALID', 'Tags phải là mảng chuỗi', 400)
  }
  const tags = []
  for (const raw of rawTags) {
    if (typeof raw !== 'string') {
      throw new YoutubePublishError('YOUTUBE_TAGS_INVALID', 'Tags phải là mảng chuỗi', 400)
    }
    const tag = raw.trim()
    if (!tag) continue
    if (tag.length > TAG_MAX_LENGTH) {
      throw new YoutubePublishError('YOUTUBE_TAG_TOO_LONG', `Mỗi tag tối đa ${TAG_MAX_LENGTH} ký tự`, 400)
    }
    tags.push(tag)
  }
  if (tags.length > TAG_MAX_COUNT) {
    throw new YoutubePublishError('YOUTUBE_TOO_MANY_TAGS', `Tối đa ${TAG_MAX_COUNT} tags`, 400)
  }
  if (tags.join(',').length > TAGS_TOTAL_MAX) {
    throw new YoutubePublishError('YOUTUBE_TAGS_TOO_LONG', `Tổng độ dài tags tối đa ${TAGS_TOTAL_MAX} ký tự`, 400)
  }

  const categoryRaw = input.categoryId === undefined || input.categoryId === null || input.categoryId === ''
    ? DEFAULT_CATEGORY_ID
    : String(input.categoryId).trim()
  if (!/^\d{1,2}$/.test(categoryRaw)) {
    throw new YoutubePublishError('YOUTUBE_CATEGORY_INVALID', 'Category ID phải là số 1..44', 400)
  }
  const categoryId = Number(categoryRaw)
  if (!Number.isInteger(categoryId) || categoryId < 1 || categoryId > 44) {
    throw new YoutubePublishError('YOUTUBE_CATEGORY_INVALID', 'Category ID phải là số 1..44', 400)
  }

  const privacy = input.privacy === undefined || input.privacy === null || input.privacy === ''
    ? 'private'
    : String(input.privacy)
  if (!YOUTUBE_PRIVACY.includes(privacy)) {
    throw new YoutubePublishError('YOUTUBE_PRIVACY_INVALID', `Privacy phải là một trong ${YOUTUBE_PRIVACY.join(', ')}`, 400)
  }

  if (input.confirmed !== true) {
    throw new YoutubePublishError('YOUTUBE_CONFIRM_REQUIRED', 'Cần xác nhận trước khi đăng video', 400)
  }

  return {
    title,
    description,
    tags,
    categoryId: String(categoryId),
    privacy,
    madeForKids: input.madeForKids === true,
    notifySubscribers: input.notifySubscribers !== false,
  }
}

function outputFilePath(output) {
  if (!output?.storage_key) return null
  const abs = resolveStorageKey(output.storage_key)
  if (!abs) return null
  try {
    const stat = fs.statSync(abs)
    return stat.isFile() && stat.size > 0 ? abs : null
  } catch (_) {
    return null
  }
}

// POST /outputs/:id/youtube → 202 { uploadId, outputId, status:'queued' }
export async function startPublish({ outputId, payload, now = Date.now() }) {
  if (!isYoutubeConfigured()) {
    throw new YoutubePublishError('YOUTUBE_NOT_CONFIGURED', 'YouTube OAuth chưa được cấu hình', 503)
  }
  const fields = validatePublishPayload(payload)

  const output = await queryOne('SELECT * FROM outputs WHERE id = ?', [outputId])
  if (!output) throw new YoutubePublishError('OUTPUT_NOT_FOUND', 'Output not found', 404)
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [output.project_id])
  if (!project) throw new YoutubePublishError('OUTPUT_NOT_FOUND', 'Output not found', 404)
  if (output.status !== 'success') {
    throw new YoutubePublishError('OUTPUT_NOT_READY', 'Output chưa sẵn sàng để đăng', 409)
  }
  const mode = String(project.mode || '').toUpperCase().replace('-', '_')
  const currentVersion = mode === 'SCRIPT_TO_VIDEO' ? project.script_version : project.transcript_version
  if (outputIsStale(project.mode, currentVersion, output)) {
    throw new YoutubePublishError('OUTPUT_STALE', 'Output đã cũ so với phiên bản hiện tại — hãy render lại trước khi đăng', 409)
  }
  if (!outputFilePath(output)) {
    throw new YoutubePublishError('OUTPUT_FILE_MISSING', 'File output không tồn tại trên server', 409)
  }

  const account = await getAccountRow(project.user_id)
  if (!account || account.status !== 'connected') {
    throw new YoutubePublishError('YOUTUBE_NOT_CONNECTED', 'Tài khoản chưa kết nối YouTube', 409)
  }

  const nowIso = new Date(now).toISOString()
  const existing = await queryOne('SELECT * FROM youtube_uploads WHERE output_id = ?', [outputId])
  if (existing && YOUTUBE_ACTIVE_STATUSES.includes(existing.status)) {
    throw new YoutubePublishError('YOUTUBE_PUBLISH_IN_PROGRESS', 'Video đang được tải lên YouTube', 409)
  }
  if (existing && existing.status === 'completed') {
    throw new YoutubePublishError('YOUTUBE_ALREADY_PUBLISHED', 'Output này đã được đăng lên YouTube', 409)
  }

  const row = await withTransaction(async (tx) => {
    const current = await tx.queryOne('SELECT * FROM youtube_uploads WHERE output_id = ?', [outputId])
    if (current && YOUTUBE_ACTIVE_STATUSES.includes(current.status)) {
      throw new YoutubePublishError('YOUTUBE_PUBLISH_IN_PROGRESS', 'Video đang được tải lên YouTube', 409)
    }
    if (current && current.status === 'completed') {
      throw new YoutubePublishError('YOUTUBE_ALREADY_PUBLISHED', 'Output này đã được đăng lên YouTube', 409)
    }
    const base = {
      project_id: output.project_id,
      account_id: account.id,
      title: fields.title,
      description: fields.description,
      tags: JSON.stringify(fields.tags),
      category_id: fields.categoryId,
      privacy: fields.privacy,
      status: 'queued',
      progress: 5,
      error_code: null,
      error_message: null,
      attempts: 0,
      next_retry_at: null,
      lease_expires_at: null,
      claimed_at: null,
      upload_session_uri: null,
      bytes_sent: 0,
      processing_attempts: 0,
      cancelled_at: null,
      updated_at: nowIso,
    }
    if (current) {
      // Keep youtube_video_id: a previous processing failure is retried by
      // polling the existing video, never by creating a duplicate upload.
      return tx.updateById('youtube_uploads', current.id, base)
    }
    return tx.insert('youtube_uploads', {
      id: uuidv4(),
      output_id: outputId,
      youtube_video_id: null,
      processing_status: null,
      youtube_url: null,
      created_date: nowIso,
      completed_at: null,
      ...base,
    })
  }, { op: 'youtube.publish.enqueue' })

  return { uploadId: row.id, outputId, status: 'queued' }
}

function toStatus(row) {
  if (!row) return { status: 'none' }
  return {
    uploadId: row.id,
    outputId: row.output_id,
    status: row.status,
    progress: Number(row.progress || 0),
    privacy: row.privacy || 'private',
    title: row.title || null,
    youtubeVideoId: row.youtube_video_id || null,
    youtubeUrl: row.youtube_url || null,
    processingStatus: row.processing_status || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    nextRetryAt: row.next_retry_at || null,
    createdAt: row.created_date || null,
    updatedAt: row.updated_at || row.created_date || null,
    completedAt: row.completed_at || null,
  }
}

export async function getPublishStatus(outputId) {
  const row = await queryOne(
    'SELECT * FROM youtube_uploads WHERE output_id = ? ORDER BY rowid DESC LIMIT 1',
    [outputId]
  )
  return toStatus(row)
}

export async function cancelPublish({ outputId, now = Date.now() }) {
  const row = await queryOne(
    'SELECT * FROM youtube_uploads WHERE output_id = ? ORDER BY rowid DESC LIMIT 1',
    [outputId]
  )
  if (!row) throw new YoutubePublishError('YOUTUBE_NOT_PUBLISHED', 'Output chưa có lần đăng YouTube nào', 409)
  if (!YOUTUBE_ACTIVE_STATUSES.includes(row.status)) {
    throw new YoutubePublishError('YOUTUBE_UPLOAD_TERMINAL', 'Không thể huỷ vì upload đã kết thúc', 409)
  }
  const nowIso = new Date(now).toISOString()
  await run(
    `UPDATE youtube_uploads SET status = 'cancelled', cancelled_at = ?, next_retry_at = NULL,
     lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status IN ('queued','uploading','processing')`,
    [nowIso, nowIso, row.id],
    { op: 'youtube.publish.cancel' }
  )
  return {
    uploadId: row.id,
    outputId,
    status: 'cancelled',
    videoCreated: Boolean(row.youtube_video_id),
    message: row.youtube_video_id
      ? 'Đã huỷ theo dõi upload. Video đã tạo trên YouTube vẫn tồn tại và cần xoá thủ công nếu muốn.'
      : 'Đã huỷ upload trước khi video được tạo.',
  }
}

export async function hasActivePublish(userId) {
  const row = await queryOne(
    `SELECT y.id FROM youtube_uploads y
     JOIN outputs o ON o.id = y.output_id
     JOIN projects p ON p.id = o.project_id
     WHERE p.user_id = ? AND y.status IN ('queued','uploading','processing')
     LIMIT 1`,
    [userId]
  )
  return Boolean(row)
}

export async function listProjectUploads(projectId) {
  return query(
    'SELECT * FROM youtube_uploads WHERE project_id = ? ORDER BY created_date DESC',
    [projectId]
  )
}

export { YoutubeError }

export default {
  YOUTUBE_PRIVACY,
  YOUTUBE_ACTIVE_STATUSES,
  YoutubePublishError,
  validatePublishPayload,
  startPublish,
  getPublishStatus,
  cancelPublish,
  hasActivePublish,
  listProjectUploads,
}
