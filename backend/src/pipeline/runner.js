import fs from 'node:fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, insert, updateById, run } from '../db/query.js'
import { logProviderCall } from '../providers/tracked.js'
import {
  projectDir,
  resolveStorageKey,
  parseJsonSafe,
  getUserSettings,
} from './context.js'
import eventBus from './eventBus.js'
import { safeAddNotify } from '../queue/notifyQueue.js'
import { classifyProviderError, ERROR_KINDS } from '../lib/providerErrors.js'
import { firstRunnableStage } from './context.js'

function isRateLimitError(err) {
  if (err?.name === 'RateLimitExhaustedError') return true
  const msg = (err?.message || '').toLowerCase()
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')
    || msg.includes('insufficient_quota') || msg.includes('retry-after')
}

function parseRetryAfter(err) {
  const msg = err?.message || ''
  const match = msg.match(/retry[_-]?after[:\s]*(\d+)/i)
  if (match) return parseInt(match[1], 10)
  return null
}

// Lỗi validation (TRANSLATE_NEEDS_REVIEW / BLOCK_RENDER) là lỗi dữ liệu, KHÔNG
// phải transient — fail fast 1 lần, không retry/backoff/park-queued. User sửa
// tay (PATCH .../segments/:id/translation, xem job.result.unresolvedDetails)
// rồi Regenerate/Retry (tự resume từ stage lỗi earliest qua firstRunnableStage).
export function isValidationError(err) {
  const msg = String(err?.message || '')
  return msg.startsWith('TRANSLATE_NEEDS_REVIEW:') || msg.startsWith('BLOCK_RENDER:')
}

async function getNextRetryAt(provider) {
  await queryOne(
    `SELECT requests_per_minute FROM provider_rate_limits WHERE provider = ? AND tier = 'free' LIMIT 1`,
    [provider]
  )
  // Next RPM reset = now + 60s (conservative)
  return new Date(Date.now() + 60 * 1000).toISOString()
}

import summaryTranscribe from './stages/summaryTranscribe.js'
import summarySceneDetect from './stages/summarySceneDetect.js'
import summaryAnalyze from './stages/summaryAnalyze.js'
import summaryScript from './stages/summaryScript.js'
import summaryAlign from './stages/summaryAlign.js'
import summaryTts from './stages/summaryTts.js'
import summarySubtitle from './stages/summarySubtitle.js'
import summaryRender from './stages/summaryRender.js'

import dubIngest from './stages/dubIngest.js'
import dubStt from './stages/dubStt.js'
import dubOcr from './stages/dubOcr.js'

import dubMerge from './stages/dubMerge.js'
import { validateForRender, dedupeTranscriptSegments } from './stages/dubMerge.js'
import dubTranslate from './stages/dubTranslate.js'
import dubTtsAlign from './stages/dubTtsAlign.js'
import dubRender from './stages/dubRender.js'

function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}

async function startDubSequential(project, setProgress, results, signal) {
  const projectId = project.id
  const params = parseParams(project.params)
  const useOcr = Boolean(params.ocrMode)
  const firstStage = useOcr ? 'dub.ocr' : 'dub.stt'

  await ensureStageJob(projectId, firstStage)
  await ensureStageJob(projectId, 'dub.merge')

  const firstJob = await loadJob(projectId, firstStage)
  const firstOk = await executeStage(
    project, firstJob, {},
    (pct) => {
      const p = Math.max(0, Math.min(99, Math.round(pct)))
      updateById('generation_jobs', firstJob.id, { progress: p }).catch(() => {})
      eventBus.publish(projectId, { stage: firstStage, status: 'running', percent: p })
    },
    results,
    false,
    signal
  )

  if (firstOk === 'waiting') return 'waiting'
  if (!firstOk) return false

  const mergeJob = await loadJob(projectId, 'dub.merge')
  const mergeOk = await executeStage(
    project, mergeJob, {},
    (pct) => {
      const p = Math.max(0, Math.min(99, Math.round(pct)))
      updateById('generation_jobs', mergeJob.id, { progress: p }).catch(() => {})
      eventBus.publish(projectId, { stage: 'dub.merge', status: 'running', percent: p })
    },
    results,
    false,
    signal
  )
  return mergeOk
}

// Stage lists mirror docs/01 §3 + docs/05 §B.
export const STAGES = {
  SUMMARY: [
    'summary.transcribe',
    'summary.sceneDetect',
    'summary.analyze',
    'summary.script',
    'summary.align',
    'summary.tts',
    'summary.subtitle',
    'summary.render',
  ],
  TRANSLATE_DUB: [
    'dub.ingest',
    'dub.stt',
    'dub.merge',
    'dub.translate',
    'dub.ttsAlign',
    'dub.render',
  ],
}

// Flat list for retry/validation endpoints (order preserved).
export function flatStages(mode) {
  return (STAGES[mode] || []).flat()
}

const STAGE_IMPL = {
  'summary.transcribe': summaryTranscribe,
  'summary.sceneDetect': summarySceneDetect,
  'summary.analyze': summaryAnalyze,
  'summary.script': summaryScript,
  'summary.align': summaryAlign,
  'summary.tts': summaryTts,
  'summary.subtitle': summarySubtitle,
  'summary.render': summaryRender,
  'dub.ingest': dubIngest,
  'dub.stt': dubStt,
  'dub.ocr': dubOcr,

  'dub.merge': dubMerge,
  'dub.translate': dubTranslate,
  'dub.ttsAlign': dubTtsAlign,
  'dub.render': dubRender,
}

const STAGE_PROVIDER = {
  'summary.transcribe': 'asr',
  'summary.sceneDetect': 'ffmpeg',
  'summary.analyze': 'vision',
  'summary.script': 'llm',
  'summary.align': 'core',
  'summary.tts': 'core',
  'summary.subtitle': 'core',
  'summary.render': 'ffmpeg',
  'dub.ingest': 'ffmpeg',
  'dub.stt': 'asr',
  'dub.ocr': 'ocr',

  'dub.merge': 'core',
  'dub.translate': 'llm',
  'dub.ttsAlign': 'tts',
  'dub.render': 'ffmpeg',
}

const RESETS = {
  'summary.transcribe': ['transcript', 'scenes', 'segments', 'clips', 'audios', 'subtitles', 'outputs'],
  'summary.sceneDetect': ['scenes', 'segments', 'clips', 'audios', 'subtitles', 'outputs'],
  'summary.analyze': ['segments', 'clips', 'audios', 'subtitles', 'outputs'],
  'summary.script': ['segments', 'clips', 'audios', 'subtitles', 'outputs'],
  'summary.align': ['clips', 'audios', 'subtitles', 'outputs'],
  'summary.tts': ['subtitles', 'outputs'],
  'summary.subtitle': ['outputs'],
  'summary.render': ['outputs'],
  // TRANSLATE_DUB (docs/02: TranscriptSegment riêng cho từng mode)
  'dub.ingest': ['transcriptSegments', 'audios', 'subtitles', 'outputs'],
  'dub.stt': ['transcriptSegments', 'audios', 'subtitles', 'outputs'],
  'dub.ocr': ['transcriptSegments', 'audios', 'subtitles', 'outputs'],

  'dub.merge': [], // dub.merge chỉ kiểm tra DB, không tạo artifacts
  'dub.translate': ['audios', 'subtitles', 'outputs'],
  'dub.ttsAlign': ['audios', 'outputs'],
  'dub.render': ['outputs'],
}

async function clearArtifacts(projectId, kinds) {
  const dir = projectDir(projectId)
  for (const kind of kinds) {
    if (kind === 'transcript') {
      try { fs.unlinkSync(path.join(dir, 'transcript.json')) } catch (_) {}
    } else if (kind === 'transcriptSegments') {
      await run(`DELETE FROM transcript_segments WHERE project_id = ?`, [projectId])
    } else if (kind === 'scenes') {
      await run(`DELETE FROM scenes WHERE project_id = ?`, [projectId])
      fs.rmSync(path.join(dir, 'thumbs'), { recursive: true, force: true })
    } else if (kind === 'segments') {
      await run(`DELETE FROM script_segments WHERE project_id = ?`, [projectId])
    } else if (kind === 'clips') {
      await run(`DELETE FROM timeline_clips WHERE project_id = ?`, [projectId])
    } else if (kind === 'audios') {
      const rows = await query(`SELECT storage_key FROM audios WHERE project_id = ?`, [projectId])
      for (const r of rows) {
        const abs = resolveStorageKey(r.storage_key)
        if (abs && abs.startsWith(dir)) {
          try { fs.unlinkSync(abs) } catch (_) {}
        }
      }
      await run(`DELETE FROM audios WHERE project_id = ?`, [projectId])
      await run(`UPDATE transcript_segments SET tts_audio_id = NULL WHERE project_id = ?`, [projectId])
    } else if (kind === 'subtitles') {
      await run(`DELETE FROM subtitles WHERE project_id = ?`, [projectId])
      try { fs.unlinkSync(path.join(dir, 'subtitles.srt')) } catch (_) {}
      try { fs.unlinkSync(path.join(dir, 'subtitles.ass')) } catch (_) {}
    } else if (kind === 'outputs') {
      await run(
        `DELETE FROM youtube_uploads WHERE output_id IN (SELECT id FROM outputs WHERE project_id = ?)`,
        [projectId]
      )
      const rows = await query(
        `SELECT storage_key FROM outputs WHERE project_id = ? AND storage_key IS NOT NULL`,
        [projectId]
      )
      for (const r of rows) {
        const abs = resolveStorageKey(r.storage_key)
        if (abs && !abs.startsWith(dir)) {
          try { fs.unlinkSync(abs) } catch (_) {}
        }
      }
      await run(`DELETE FROM outputs WHERE project_id = ?`, [projectId])
    }
  }
}

function checkInputs(project) {
  // Cả hai mode đều dùng 1 video nguồn duy nhất (docs/01 §3).
  const keys = [project.source_video_key]
  for (const k of keys.filter(Boolean)) {
    const abs = resolveStorageKey(k)
    if (!abs || !fs.existsSync(abs)) {
      throw new Error(`Tệp nguồn không tồn tại trong kho lưu trữ: ${k}. Hãy upload lại tệp rồi Regenerate.`)
    }
  }
}

export function describeFailure(errOrMessage, stage) {
  const err = typeof errOrMessage === 'string' ? { message: errOrMessage } : (errOrMessage || {})
  const message = String(err?.message || errOrMessage || '')
  if (message.startsWith('TRANSLATE_NEEDS_REVIEW:') || message.startsWith('BLOCK_RENDER:')) {
    return { category: 'VALIDATION', retryable: false, provider: STAGE_PROVIDER[stage] || 'core' }
  }
  if (isRateLimitError(err)) {
    return { category: 'RATE_LIMIT', retryable: true, provider: STAGE_PROVIDER[stage] || 'core' }
  }
  if (message === 'Cancelled') {
    return { category: 'CANCELLED', retryable: false, provider: STAGE_PROVIDER[stage] || 'core' }
  }
  try {
    const cls = classifyProviderError(err)
    return { category: cls.kind, retryable: cls.retryable === true, provider: STAGE_PROVIDER[stage] || 'core' }
  } catch (_) {
    return { category: 'UNKNOWN', retryable: false, provider: STAGE_PROVIDER[stage] || 'core' }
  }
}

function logStageFailure({ projectId, stage, errOrMessage, attempt, nextRetryAt = null }) {
  const { category, retryable, provider } = describeFailure(errOrMessage, stage)
  const msg = String((errOrMessage && errOrMessage.message) || errOrMessage || '').slice(0, 300)
  console.error(
    `[Pipeline] project=${projectId} stage=${stage} category=${category} attempt=${attempt} ` +
    `provider=${provider} retryable=${retryable} nextRetryAt=${nextRetryAt || '-'} error=${msg}`
  )
}

async function failJob(job, projectId, message) {
  const attempt = (job.attempts || 0) + 1
  logStageFailure({ projectId, stage: job.type, errOrMessage: message, attempt })
  await updateById('generation_jobs', job.id, {
    status: 'failed',
    step: 'error',
    progress: 0,
    error_message: String(message).slice(0, 500),
  })
  eventBus.publish(projectId, { stage: job.type, status: 'failed', percent: 0 })
  await logProviderCall({
    projectId,
    jobId: job.id,
    provider: STAGE_PROVIDER[job.type] || 'core',
    type: 'media',
    status: 'error',
    error: String(message).slice(0, 500),
  })
}

// Park a run halted by a rate-limit cooldown: mark the project queued so
// drainQueued (or a manual retry after next_retry_at) resumes from the
// earliest incomplete stage. Marking it failed would mislead; advancing
// would BLOCK_RENDER-fail downstream stages on missing artifacts.
async function parkProjectForRetry(projectId, stageType) {
  await updateById('projects', projectId, { status: 'queued' })
  eventBus.publish(projectId, { stage: stageType, status: 'retry', percent: 0 })
}

async function ensureStageJob(projectId, type) {
  const existing = await queryOne(
    'SELECT id FROM generation_jobs WHERE project_id = ? AND type = ?',
    [projectId, type]
  )
  if (!existing) {
    await insert('generation_jobs', {
      id: uuidv4(),
      project_id: projectId,
      type,
      status: 'pending',
      attempts: 0,
    })
  }
}

async function loadJob(projectId, type) {
  return queryOne(
    'SELECT * FROM generation_jobs WHERE project_id = ? AND type = ?',
    [projectId, type]
  )
}

function withTimeout(promise, ms, label = 'Stage') {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} bị timeout sau ${Math.round(ms / 1000)}s – có thể FFmpeg đang treo.`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Retry policy (transflow doc 15 §7): backoff theo từng nhóm stage
export const RETRY_POLICY = {
  'dub.ttsAlign': { maxRetries: 3, backoffMs: [10_000, 30_000, 60_000] }, // 10s, 30s, 60s
  'dub.render': { maxRetries: 2, backoffMs: [30_000, 120_000] },           // 30s, 120s
  'dub.stt': { maxRetries: 3, backoffMs: [10_000, 30_000, 60_000] },
  'dub.translate': { maxRetries: 3, backoffMs: [5_000, 15_000, 30_000] },
}

const STAGE_TIMEOUTS = {
  'summary.render': 30 * 60 * 1000,
  'dub.render': 30 * 60 * 1000,
  'summary.align': 15 * 60 * 1000,
  'dub.ttsAlign': 15 * 60 * 1000,
}
const DEFAULT_STAGE_TIMEOUT = 15 * 60 * 1000

// Execute ONE stage end-to-end (reset → running → impl → success/fail).
// Trả về true nếu thành công/skip, false nếu thất bại.
async function executeStage(project, job, settings, setProgress, results, isFirstExecutedStage, signal) {
  const projectId = project.id
  try {
    // Check if this is a retry-stage waiting for cooldown.
    // Return the 'waiting' sentinel (NOT true): the caller must halt the run,
    // otherwise it would advance to downstream stages that BLOCK_RENDER-fail
    // on the missing artifacts of this stage.
    if (job.status === 'retry' && job.next_retry_at) {
      const retryAt = new Date(job.next_retry_at)
      if (Date.now() < retryAt.getTime()) {
        return 'waiting'
      }
    }

    await clearArtifacts(projectId, RESETS[job.type] || [])

    if (job.status !== 'pending' && job.status !== 'retry') {
      await updateById('generation_jobs', job.id, { status: 'pending', error_message: null })
    }
    await updateById('generation_jobs', job.id, {
      status: 'running',
      step: 'processing',
      attempts: (job.attempts || 0) + 1,
      progress: 0,
    })
    eventBus.publish(projectId, { stage: job.type, status: 'running', percent: 0 })

    if (isFirstExecutedStage) {
      checkInputs(project)
    }

    // Check if already cancelled
    if (signal && signal.aborted) {
      throw new Error('Cancelled')
    }

    // BLOCK_RENDER validation trước khi render (transflow doc 15 §5.0)
    if (job.type === 'dub.render') {
      // Auto-merge câu STT lặp nguyên văn trước khi validate để gỡ BLOCK
      // DUPLICATE_SUBTITLE cho project đang kẹt (dub.merge đã success nên
      // Regenerate từ dub.render sẽ không chạy lại stage đó). Best-effort.
      try {
        await dedupeTranscriptSegments(projectId)
      } catch (e) {
        console.warn(`[RenderValidation] auto-merge bỏ qua: ${String(e?.message || e).slice(0, 160)}`)
      }
      const validation = await validateForRender(projectId)
      for (const w of validation.warnings || []) {
        console.warn(`[RenderValidation] warning ${w.code}: ${w.message}`)
      }
      if (!validation.valid) {
        const hasDupSubtitle = (validation.errors || []).some((e) => e.code === 'DUPLICATE_SUBTITLE')
        const dupHint = hasDupSubtitle
          ? ' (đã tự gộp các câu STT lặp nguyên văn; các câu còn lại khác nhau dấu câu/chữ — kiểm tra transcript, sửa timing/text rồi Regenerate)'
          : ''
        const errorMsg = `BLOCK_RENDER: ${validation.errors.map(e => e.message).join('; ')}${dupHint}` +
          ` — sửa segment lỗi rồi Regenerate/Retry (tự chạy lại từ stage lỗi earliest; bản dịch sửa tay qua PATCH /projects/:id/segments/:segmentId/translation, chi tiết ở dub.translate job.result.unresolvedDetails)`
        await failJob(job, projectId, errorMsg)
        return false
      }
    }

    const impl = STAGE_IMPL[job.type]
    if (!impl) throw new Error(`Stage không được hỗ trợ: ${job.type}`)
    const stageTimeout = STAGE_TIMEOUTS[job.type] || DEFAULT_STAGE_TIMEOUT
    const result = await withTimeout(
      impl({ project, job, settings, setProgress, results, signal }),
      stageTimeout,
      job.type
    )
    results[job.type] = result

    await updateById('generation_jobs', job.id, {
      status: 'success',
      step: 'done',
      progress: 100,
      result: JSON.stringify(result || {}),
    })
    eventBus.publish(projectId, { stage: job.type, status: 'success', percent: 100 })
    return true
  } catch (err) {
    // Validation fail fast trước mọi xử lý retry: lỗi dữ liệu không tự khỏi
    // theo thời gian, retry cùng input chỉ spam log (từng lặp 5x BLOCK_RENDER).
    if (isValidationError(err)) {
      await failJob(job, projectId, err.message)
      return false
    }
    if (isRateLimitError(err)) {
      // Rate-limited: retry with scheduled nextRetryAt (docs/11 §4.2)
      const MAX_RATE_LIMIT_RETRIES = 5
      const attempts = (job.attempts || 0) + 1

      if (attempts >= MAX_RATE_LIMIT_RETRIES) {
        await failJob(job, projectId, `PROV_002: Tất cả key cho provider đã hết quota sau ${attempts} lần retry`)
        return false
      }

      const retryAfter = parseRetryAfter(err)
      const nextRetryAt = retryAfter
        ? new Date(Date.now() + retryAfter * 1000).toISOString()
        : await getNextRetryAt(STAGE_PROVIDER[job.type] || 'unknown')

      await updateById('generation_jobs', job.id, {
        status: 'retry',
        step: 'rate_limited',
        attempts,
        next_retry_at: nextRetryAt,
        error_message: `Rate limited: ${err.message}`,
      })
      eventBus.publish(projectId, {
        stage: job.type,
        status: 'retry',
        nextRetryAt,
        percent: 0,
      })
      // Halt (don't advance): downstream stages would fail on this stage's
      // missing artifacts. runPipeline parks the project as queued for resume.
      return 'waiting'
    }

    // Transient provider failure (503/timeout/network blip) → bounded retry
    // with stage backoff (RETRY_POLICY). Permanent/Configuration/Invalid →
    // fail fast (retrying cannot help). Validation already handled above.
    // 'Cancelled' never retries.
    if (String(err?.message || '') !== 'Cancelled') {
      let kind = null
      try {
        kind = classifyProviderError(err).kind
      } catch (_) {}
      if (kind === ERROR_KINDS.TRANSIENT) {
        const policy = RETRY_POLICY[job.type] || { maxRetries: 2, backoffMs: [10_000, 30_000] }
        const attempts = (job.attempts || 0) + 1
        if (attempts <= policy.maxRetries) {
          const delayMs = policy.backoffMs[Math.min(attempts - 1, policy.backoffMs.length - 1)]
          const nextRetryAt = new Date(Date.now() + delayMs).toISOString()
          await updateById('generation_jobs', job.id, {
            status: 'retry',
            step: 'transient',
            attempts,
            next_retry_at: nextRetryAt,
            error_message: `Transient: ${String(err.message).slice(0, 400)}`,
          })
          eventBus.publish(projectId, {
            stage: job.type,
            status: 'retry',
            nextRetryAt,
            percent: 0,
          })
          logStageFailure({ projectId, stage: job.type, errOrMessage: err, attempt: attempts, nextRetryAt })
          return 'waiting'
        }
      }
    }

    await failJob(job, projectId, err.message)
    return false
  }
}

const activeRuns = new Set()
const abortControllers = new Map() // projectId → AbortController

export function isPipelineRunning(projectId) {
  return activeRuns.has(projectId)
}

function nowIso() {
  return new Date().toISOString()
}

// Heartbeat: marks a running pipeline as alive so unified recovery never
// mistakes a long-but-healthy run for a stale one. Conditional on
// status='running' so a cancelled/failed project is never resurrected.
export async function touchHeartbeat(projectId) {
  try {
    await run(
      `UPDATE projects SET last_heartbeat_at = ? WHERE id = ? AND status = 'running'`,
      [nowIso(), projectId]
    )
  } catch (_) {}
}

export function abortPipeline(projectId) {
  const ac = abortControllers.get(projectId)
  if (ac) ac.abort()
}

export async function runPipeline(projectId, fromStage = null) {
  if (activeRuns.has(projectId)) return
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  if (!project) return

  // Distributed guard: DB says 'running' with a FRESH heartbeat means another
  // process owns this run — do not double-start. Only a stale 'running'
  // (heartbeat older than timeout, i.e. previous crash) may be taken over.
  if (project.status === 'running') {
    const hb = project.last_heartbeat_at || project.started_at || null
    let stale = true
    if (hb) {
      try {
        const { config: cfg } = await import('../config.js')
        const timeoutMin = Number(cfg.recoveryStaleMinutes || 10)
        stale = new Date(hb).getTime() < Date.now() - timeoutMin * 60 * 1000
      } catch (_) {
        stale = false
      }
    }
    if (!stale) return // owned by a live run elsewhere
    console.warn(`[Pipeline] Project ${projectId} was stale 'running' — resetting to pending`)
    await updateById('projects', projectId, { status: 'pending' })
    project.status = 'pending'
  }

  // Per-user concurrency enforcement at the single choke point every caller
  // flows through (create, regenerate, retry, redub, drain). DB-counted so
  // it holds across processes; parks excess starts as queued for later drain.
  if (project.status !== 'running') {
    try {
      const { config: cfg } = await import('../config.js')
      const maxConcurrent = Number(cfg.maxConcurrentProjectsPerUser || 2)
      const running = await queryOne(
        `SELECT COUNT(*) as cnt FROM projects WHERE user_id = ? AND status = 'running'`,
        [project.user_id]
      )
      if ((running?.cnt || 0) >= maxConcurrent) {
        await updateById('projects', projectId, { status: 'queued' })
        return
      }
    } catch (_) {}
  }

  activeRuns.add(projectId)

  // Create AbortController for this pipeline run
  const abortController = new AbortController()
  abortControllers.set(projectId, abortController)
  const { signal } = abortController

  try {
    const stageGroups = STAGES[project.mode] || []
    for (const group of stageGroups) {
      const list = Array.isArray(group) ? group : [group]
      for (const type of list) await ensureStageJob(projectId, type)
    }

    // Clamp fromStage to the earliest incomplete stage in pipeline order.
    // Never skip an incomplete predecessor (e.g. redub forcing dub.ttsAlign
    // while dub.translate is failed → deterministic BLOCK_RENDER). Callers
    // already use firstRunnableStage, this is the enforcement point.
    let effectiveFrom = fromStage
    if (effectiveFrom) {
      try {
        const allJobs = await query(
          'SELECT type, status, next_retry_at FROM generation_jobs WHERE project_id = ?',
          [projectId]
        )
        const r = firstRunnableStage(STAGES[project.mode] || [], allJobs)
        if (r.waiting) {
          await parkProjectForRetry(projectId, r.type)
          return
        }
        if (r.type && r.type !== effectiveFrom) {
          console.warn(`[Pipeline] Clamped resume ${effectiveFrom} → ${r.type} (earliest incomplete) for ${projectId}`)
          effectiveFrom = r.type
        }
      } catch (_) {}
    }

    const startedAt = nowIso()
    await updateById('projects', projectId, { status: 'running', progress: 0, started_at: startedAt, last_heartbeat_at: startedAt })
    eventBus.publish(projectId, { stage: '__project__', status: 'running', percent: 0 })

    let started = !effectiveFrom
    let isFirstExecutedStage = true
    const total = stageGroups.length
    let done = 0

    const priorJobs = await query('SELECT type, result FROM generation_jobs WHERE project_id = ?', [projectId])
    const results = {}
    for (const j of priorJobs) {
      const parsed = parseJsonSafe(j.result)
      if (parsed) results[j.type] = parsed
    }

    const settings = await getUserSettings(project.user_id)
    // Dự án có thể được cập nhật giữa pipeline (vd dub.ingest đo duration)
    let currentProject = project

    for (const group of stageGroups) {
      const types = Array.isArray(group) ? group : [group]

      if (!started) {
        if (types.includes(effectiveFrom)) started = true
        else continue
      }

      let groupFailed = false
      if (types.length === 1) {
        const job = await loadJob(projectId, types[0])
        const ok = await executeStage(
          currentProject, job, settings,
          (pct) => {
            const p = Math.max(0, Math.min(99, Math.round(pct)))
            updateById('generation_jobs', job.id, { progress: p }).catch(() => {})
            eventBus.publish(projectId, { stage: job.type, status: 'running', percent: p })
          },
          results,
          isFirstExecutedStage,
          signal
        )
        isFirstExecutedStage = false
        if (ok === 'waiting') {
          await parkProjectForRetry(projectId, types[0])
          return
        }
        if (!ok) groupFailed = true
      } else {
        // dub.stt followed by dub.merge sequentially
        const ok = await startDubSequential(
          currentProject,
          (pct) => {
            const p = Math.max(0, Math.min(99, Math.round(pct)))
            eventBus.publish(projectId, { stage: '__sequential__', status: 'running', percent: p })
          },
          results,
          signal
        )
        isFirstExecutedStage = false
        if (ok === 'waiting') {
          await parkProjectForRetry(projectId, 'dub.stt')
          return
        }
        if (!ok) groupFailed = true
      }

      if (groupFailed) {
        await updateById('projects', projectId, { status: 'failed' })
        eventBus.publish(projectId, { stage: '__project__', status: 'failed', percent: done / total * 100 })
        return
      }

      done++
      await updateById('projects', projectId, {
        progress: Math.round((done / total) * 100),
        last_heartbeat_at: nowIso(),
      })
      eventBus.publish(projectId, {
        stage: '__project__',
        status: done >= total ? 'completed' : 'running',
        percent: Math.round((done / total) * 100),
      })
      currentProject = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId]) || currentProject
    }

    await updateById('projects', projectId, { status: 'completed', progress: 100 })
    eventBus.publish(projectId, { stage: '__project__', status: 'completed', percent: 100 })

    // Isolated: queue failure must never fail a successful video pipeline.
    // safeAddNotify skips when any Redis stream is down and converts
    // "Stream isn't writeable" into a skip instead of a throw.
    try {
      const user = await queryOne('SELECT email FROM users WHERE id = ?', [project.user_id])
      if (user?.email) {
        await safeAddNotify('projectDone', {
          projectId,
          projectTitle: project.title,
          userEmail: user.email,
          status: 'success',
          mode: project.mode,
        })
      }
    } catch (notifyErr) {
      console.error('[Pipeline] Notification failed:', notifyErr.message)
    }
  } catch (err) {
    console.error('[Pipeline] lỗi:', err)
    await updateById('projects', projectId, { status: 'failed' })
    eventBus.publish(projectId, { stage: '__project__', status: 'failed', percent: 0 })

    // Isolated: queue failure must never corrupt pipeline failure handling.
    try {
      const user = await queryOne('SELECT email FROM users WHERE id = ?', [project.user_id])
      if (user?.email) {
        await safeAddNotify('projectDone', {
          projectId,
          projectTitle: project.title,
          userEmail: user.email,
          status: 'failed',
          mode: project.mode,
        })
      }
    } catch (notifyErr) {
      console.error('[Pipeline] Notification failed:', notifyErr.message)
    }
  } finally {
    activeRuns.delete(projectId)
    abortControllers.delete(projectId)
  }
}

export default { runPipeline, STAGES, flatStages }
