import fs from 'node:fs'
import { queryOne, run, runAffected, withTransaction } from '../../db/query.js'
import { resolveStorageKey } from '../../pipeline/context.js'
import { youtubeClient } from '../../lib/youtubeClient.js'
import {
  getAccountRow,
  getValidAccessToken,
  forceRefreshAccessToken,
} from '../../services/youtubeOAuthService.js'
import { outputIsStale } from '../../services/outputService.js'

// DB-outbox upload worker: deliberately independent of Redis/BullMQ. Claims a
// due row, uploads with a resumable session, then polls YouTube processing.
// Every failure is reduced to a stable code; upstream text (which may embed a
// token) is never persisted.

const LEASE_MS = 10 * 60 * 1000
const PROCESSING_POLL_MS = 30 * 1000
const MAX_PROCESSING_POLLS = 40
const MAX_ATTEMPTS = 6
const CHUNK_SIZE = 8 * 1024 * 1024 // multiple of 256KB, required by Google
const RETRY_DELAYS_SEC = [60, 300, 900, 3600, 3600]
const PERMANENT_CODES = new Set([
  'OUTPUT_MISSING',
  'OUTPUT_FILE_MISSING',
  'OUTPUT_STALE',
  'OUTPUT_NOT_READY',
  'YOUTUBE_NOT_CONNECTED',
  'YOUTUBE_REAUTH_REQUIRED',
  'YOUTUBE_RESPONSE_INVALID',
])

function safeCode(err) {
  const code = String(err?.code || 'YOUTUBE_ERROR')
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'YOUTUBE_ERROR'
}

function safeMessage(err) {
  const message = String(err?.message || '')
  if (/^[A-Z][A-Z0-9_]{2,63}( \(HTTP \d+\))?$/.test(message)) return message
  return safeCode(err)
}

function parseTagList(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string' && t.trim()) : []
  } catch (_) {
    return []
  }
}

function parseRangeEnd(range) {
  const match = /bytes=(\d+)-(\d+)/.exec(String(range || ''))
  return match ? Number(match[2]) + 1 : null
}

function retryDelayMs(attempts) {
  const index = Math.max(0, Math.min(RETRY_DELAYS_SEC.length - 1, Number(attempts || 1) - 1))
  return RETRY_DELAYS_SEC[index] * 1000
}

async function updateUpload(id, fields, op) {
  const cols = Object.keys(fields)
  if (!cols.length) return
  const sets = cols.map((c) => `${c} = ?`).join(', ')
  await run(
    `UPDATE youtube_uploads SET ${sets} WHERE id = ?`,
    [...cols.map((c) => fields[c]), id],
    { op: op || 'youtube.upload.update' }
  )
}

// Status transitions are conditional so a concurrent cancel is never undone.
async function transition(id, fromStatus, fields, op) {
  const cols = Object.keys(fields)
  const sets = cols.map((c) => `${c} = ?`).join(', ')
  const changed = await runAffected(
    `UPDATE youtube_uploads SET ${sets} WHERE id = ? AND status = ?`,
    [...cols.map((c) => fields[c]), id, fromStatus],
    { op: op || 'youtube.upload.transition' }
  )
  return changed === 1
}

// Failure/retry can happen while the row is uploading OR already processing
// (a processing poll throws after completeUpload moved it). Never touch a
// cancelling/cancelled row or a terminal one.
async function transitionActive(id, fields, op) {
  const cols = Object.keys(fields)
  const sets = cols.map((c) => `${c} = ?`).join(', ')
  const changed = await runAffected(
    `UPDATE youtube_uploads SET ${sets}
     WHERE id = ? AND status IN ('queued','uploading','processing')`,
    [...cols.map((c) => fields[c]), id],
    { op: op || 'youtube.upload.transition' }
  )
  return changed === 1
}

async function failPermanent(row, code, message, nowIso) {
  await transitionActive(row.id, {
    status: 'failed',
    error_code: code,
    error_message: message || code,
    lease_expires_at: null,
    next_retry_at: null,
    updated_at: nowIso,
  }, 'youtube.upload.fail')
}

async function failRetryable(row, err, nowIso, { videoId = null } = {}) {
  const attempts = Number(row.attempts || 1)
  const hasVideo = Boolean(videoId || row.youtube_video_id)
  if (attempts >= MAX_ATTEMPTS) {
    await transitionActive(row.id, {
      status: 'failed',
      error_code: safeCode(err),
      error_message: safeMessage(err),
      lease_expires_at: null,
      next_retry_at: null,
      updated_at: nowIso,
    }, 'youtube.upload.fail')
    return
  }
  const nextRetryAt = new Date(new Date(nowIso).getTime() + retryDelayMs(attempts)).toISOString()
  await transitionActive(row.id, {
    status: hasVideo ? 'processing' : 'queued',
    error_code: safeCode(err),
    error_message: safeMessage(err),
    lease_expires_at: null,
    next_retry_at: nextRetryAt,
    updated_at: nowIso,
  }, 'youtube.upload.retry')
}

async function markCompleted(row, nowIso, processingStatus) {
  return transition(row.id, 'processing', {
    status: 'completed',
    progress: 100,
    processing_status: processingStatus || 'processed',
    error_code: null,
    error_message: null,
    next_retry_at: null,
    lease_expires_at: null,
    completed_at: nowIso,
    updated_at: nowIso,
  }, 'youtube.upload.completed')
}

async function markProcessingFailed(row, code, message, nowIso, processingStatus) {
  return transition(row.id, 'processing', {
    status: 'failed',
    processing_status: processingStatus || 'failed',
    error_code: code,
    error_message: message || code,
    next_retry_at: null,
    lease_expires_at: null,
    updated_at: nowIso,
  }, 'youtube.upload.fail')
}

async function pollProcessing(row, accessToken, { client, now, nowIso }) {
  let item
  try {
    item = await client.fetchVideoStatus({ accessToken, videoId: row.youtube_video_id })
  } catch (err) {
    // Video metadata can lag behind a just-finished upload; treat 404/410 as
    // "not visible yet" instead of a terminal failure.
    if (err?.status === 404 || err?.status === 410) item = null
    else throw err
  }
  const uploadStatus = item?.status?.uploadStatus || null
  const processingStatus = uploadStatus || item?.processingDetails?.processingStatus || null
  if (uploadStatus === 'processed') {
    await markCompleted(row, nowIso, 'processed')
    return
  }
  if (uploadStatus === 'failed' || uploadStatus === 'rejected') {
    await markProcessingFailed(row, 'YOUTUBE_PROCESSING_FAILED', 'YouTube xử lý video thất bại', nowIso, uploadStatus)
    return
  }
  const polls = Number(row.processing_attempts || 0) + 1
  if (polls > MAX_PROCESSING_POLLS) {
    await markProcessingFailed(
      row,
      'YOUTUBE_PROCESSING_TIMEOUT',
      'YouTube xử lý quá lâu — video có thể vẫn đang xử lý, hãy kiểm tra lại sau',
      nowIso,
      processingStatus
    )
    return
  }
  await transition(row.id, 'processing', {
    status: 'processing',
    progress: 85,
    processing_status: processingStatus || 'uploaded',
    processing_attempts: polls,
    next_retry_at: new Date(now() + PROCESSING_POLL_MS).toISOString(),
    lease_expires_at: null,
    updated_at: nowIso,
  }, 'youtube.upload.poll')
}

async function isCancelled(id) {
  const fresh = await queryOne('SELECT status, cancelled_at FROM youtube_uploads WHERE id = ?', [id])
  return !fresh || fresh.status === 'cancelled' || Boolean(fresh.cancelled_at)
}

async function processUpload(row, { client = youtubeClient, now = Date.now } = {}) {
  if (await isCancelled(row.id)) return
  const nowIso = new Date(now()).toISOString()

  const output = await queryOne('SELECT * FROM outputs WHERE id = ?', [row.output_id])
  if (!output) return failPermanent(row, 'OUTPUT_MISSING', 'Output không còn tồn tại', nowIso)
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [output.project_id])
  if (!project) return failPermanent(row, 'OUTPUT_MISSING', 'Project không còn tồn tại', nowIso)
  const mode = String(project.mode || '').toUpperCase().replace('-', '_')
  const currentVersion = mode === 'SCRIPT_TO_VIDEO' ? project.script_version : project.transcript_version
  if (outputIsStale(project.mode, currentVersion, output)) {
    return failPermanent(row, 'OUTPUT_STALE', 'Output đã cũ — hãy render lại trước khi đăng', nowIso)
  }

  const account = await getAccountRow(project.user_id)
  if (!account || account.status !== 'connected') {
    return failPermanent(row, 'YOUTUBE_NOT_CONNECTED', 'Tài khoản chưa kết nối YouTube', nowIso)
  }

  let accessToken
  try {
    accessToken = await getValidAccessToken(account, { client, now: now() })
  } catch (err) {
    if (String(err?.code) === 'YOUTUBE_REAUTH_REQUIRED') {
      return failPermanent(row, 'YOUTUBE_REAUTH_REQUIRED', 'Cần kết nối lại YouTube', nowIso)
    }
    throw err
  }
  if (await isCancelled(row.id)) return

  if (row.youtube_video_id) {
    return pollProcessing(row, accessToken, { client, now, nowIso })
  }

  const filePath = output.storage_key ? resolveStorageKey(output.storage_key) : null
  let stat
  try {
    stat = filePath ? fs.statSync(filePath) : null
  } catch (_) {
    stat = null
  }
  if (!stat || !stat.isFile() || stat.size <= 0) {
    return failPermanent(row, 'OUTPUT_FILE_MISSING', 'File output không tồn tại trên server', nowIso)
  }
  const total = stat.size

  let sessionUri = row.upload_session_uri || null
  if (!sessionUri) {
    await updateUpload(row.id, { progress: 15, updated_at: nowIso }, 'youtube.upload.initiate')
    const metadata = {
      snippet: {
        title: row.title || 'Video',
        description: row.description || '',
        tags: parseTagList(row.tags),
        categoryId: row.category_id || '22',
      },
      status: {
        privacyStatus: row.privacy || 'private',
        selfDeclaredMadeForKids: false,
      },
    }
    try {
      sessionUri = await client.initiateResumableUpload({ accessToken, metadata, size: total })
    } catch (err) {
      throw err
    }
    await updateUpload(row.id, {
      upload_session_uri: sessionUri,
      bytes_sent: 0,
      updated_at: nowIso,
    }, 'youtube.upload.session')
  }

  if (await isCancelled(row.id)) return

  // Resume from the byte the server confirms; a lost session restarts cleanly.
  let start = Number(row.bytes_sent || 0)
  try {
    const probe = await client.queryUploadStatus({ sessionUri, total })
    if (probe.complete && probe.video?.id) {
      await completeUpload(row, probe.video, { client, now, nowIso, output, accessToken, total })
      return
    }
    const authoritative = parseRangeEnd(probe.range)
    // Google may answer a zero-byte session probe with "bytes=0-0"; that is an
    // empty session, not one byte uploaded (our chunks are 8MB).
    if (authoritative !== null && !(start === 0 && authoritative === 1)) start = authoritative
  } catch (err) {
    if (err?.status === 404 || err?.status === 410) {
      await updateUpload(row.id, {
        upload_session_uri: null,
        bytes_sent: 0,
        updated_at: nowIso,
      }, 'youtube.upload.session.expired')
      const expired = new Error('YOUTUBE_SESSION_EXPIRED')
      expired.code = 'YOUTUBE_SESSION_EXPIRED'
      expired.retryable = true
      throw expired
    }
    throw err
  }
  if (start > 0) {
    await updateUpload(row.id, { bytes_sent: start, updated_at: nowIso }, 'youtube.upload.resume')
  }

  const maxIterations = Math.min(10_000, Math.ceil(total / CHUNK_SIZE) + 10)
  for (let i = 0; i < maxIterations; i++) {
    if (await isCancelled(row.id)) return
    if (start >= total) {
      const err = new Error('YOUTUBE_RESPONSE_INVALID')
      err.code = 'YOUTUBE_RESPONSE_INVALID'
      err.retryable = false
      throw err
    }
    const end = Math.min(start + CHUNK_SIZE - 1, total - 1)
    let result
    try {
      result = await client.uploadChunk({ sessionUri, filePath, start, end, total })
    } catch (err) {
      if (err?.status === 404 || err?.status === 410) {
        await updateUpload(row.id, {
          upload_session_uri: null,
          bytes_sent: 0,
          updated_at: nowIso,
        }, 'youtube.upload.session.expired')
        const expired = new Error('YOUTUBE_SESSION_EXPIRED')
        expired.code = 'YOUTUBE_SESSION_EXPIRED'
        expired.retryable = true
        throw expired
      }
      throw err
    }
    if (result.complete) {
      if (!result.video?.id) {
        const err = new Error('YOUTUBE_RESPONSE_INVALID')
        err.code = 'YOUTUBE_RESPONSE_INVALID'
        err.retryable = false
        throw err
      }
      await completeUpload(row, result.video, { client, now, nowIso, output, accessToken, total })
      return
    }
    const acknowledged = parseRangeEnd(result.range)
    start = acknowledged !== null ? acknowledged : end + 1
    const progress = Math.min(80, 20 + Math.floor((60 * start) / total))
    await updateUpload(row.id, {
      bytes_sent: start,
      progress,
      updated_at: new Date(now()).toISOString(),
    }, 'youtube.upload.progress')
  }
  const err = new Error('YOUTUBE_UPLOAD_INCOMPLETE')
  err.code = 'YOUTUBE_UPLOAD_INCOMPLETE'
  err.retryable = true
  throw err
}

async function completeUpload(row, video, { client, now, nowIso, output, accessToken, total }) {
  const videoId = video.id
  const moved = await transition(row.id, 'uploading', {
    status: 'processing',
    progress: 85,
    youtube_video_id: videoId,
    youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
    processing_status: 'uploaded',
    processing_attempts: 0,
    bytes_sent: total,
    error_code: null,
    error_message: null,
    next_retry_at: new Date(now() + PROCESSING_POLL_MS).toISOString(),
    lease_expires_at: null,
    updated_at: nowIso,
  }, 'youtube.upload.uploaded')
  if (!moved) return // cancelled meanwhile

  // Thumbnail is best-effort: a failure must not fail the publish.
  try {
    const thumbPath = output.thumbnail_key ? resolveStorageKey(output.thumbnail_key) : null
    if (thumbPath && fs.existsSync(thumbPath)) {
      await client.setThumbnail({ accessToken, videoId, filePath: thumbPath })
    }
  } catch (_) {}

  const fresh = await queryOne('SELECT * FROM youtube_uploads WHERE id = ?', [row.id])
  if (!fresh || fresh.status !== 'processing') return
  await pollProcessing(fresh, accessToken, { client, now, nowIso: new Date(now()).toISOString() })
}

async function handleFailure(row, err, { now = Date.now } = {}) {
  const nowIso = new Date(now()).toISOString()
  const code = safeCode(err)
  if (PERMANENT_CODES.has(code) || err?.retryable === false) {
    await failPermanent(row, code, safeMessage(err), nowIso)
    return
  }
  await failRetryable(row, err, nowIso)
}

async function processWithAuthRetry(row, opts) {
  try {
    return await processUpload(row, opts)
  } catch (err) {
    if (String(err?.code) !== 'YOUTUBE_AUTH_FAILED') {
      return handleFailure(row, err, opts)
    }
    try {
      const output = await queryOne('SELECT * FROM outputs WHERE id = ?', [row.output_id])
      const project = output ? await queryOne('SELECT * FROM projects WHERE id = ?', [output.project_id]) : null
      const account = project ? await getAccountRow(project.user_id) : null
      if (!account) throw err
      await forceRefreshAccessToken(account, { client: opts?.client, now: opts?.now ? opts.now() : Date.now() })
      return await processUpload(row, opts)
    } catch (retryErr) {
      return handleFailure(row, retryErr, opts)
    }
  }
}

async function claimDue(nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString()
  const leaseIso = new Date(nowMs + LEASE_MS).toISOString()
  return withTransaction(async (tx) => {
    const row = await tx.queryOne(
      `SELECT * FROM youtube_uploads
       WHERE (status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= ?))
          OR (status = 'uploading' AND (lease_expires_at IS NULL OR lease_expires_at < ?))
          OR (status = 'processing' AND (next_retry_at IS NULL OR next_retry_at <= ?))
       ORDER BY COALESCE(next_retry_at, created_date) ASC, rowid ASC
       LIMIT 1`,
      [nowIso, nowIso, nowIso]
    )
    if (!row) return null
    const changed = await tx.runAffected(
      `UPDATE youtube_uploads
       SET status = 'uploading', claimed_at = ?, lease_expires_at = ?,
           attempts = COALESCE(attempts, 0) + 1, updated_at = ?
       WHERE id = ? AND status = ?`,
      [nowIso, leaseIso, nowIso, row.id, row.status]
    )
    if (changed !== 1) return null
    return tx.queryOne('SELECT * FROM youtube_uploads WHERE id = ?', [row.id])
  }, { op: 'youtube.upload.claim' })
}

export async function runYoutubeUploadTick({ client = youtubeClient, now = Date.now, limit = 5 } = {}) {
  let processed = 0
  for (let i = 0; i < limit; i++) {
    const row = await claimDue(now())
    if (!row) break
    processed += 1
    await processWithAuthRetry(row, { client, now })
  }
  return { processed }
}

export function startYoutubeUploadWorker({ intervalMs = 10_000, client = youtubeClient, now = Date.now, logger = console } = {}) {
  let running = false
  let stopped = false

  const tick = async () => {
    if (running || stopped) return { processed: 0 }
    running = true
    try {
      return await runYoutubeUploadTick({ client, now })
    } catch (err) {
      logger.warn(`[YouTube] outbox tick failed code=${safeCode(err)}`)
      return { processed: 0 }
    } finally {
      running = false
    }
  }

  tick().catch(() => {})
  const timer = setInterval(() => { tick().catch(() => {}) }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  return {
    tick,
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

export default startYoutubeUploadWorker
