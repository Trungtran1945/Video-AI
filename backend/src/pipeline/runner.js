import fs from 'node:fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, run } from '../db/query.js'
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
import { clearTranscript, clearTtsLinks } from '../services/transcriptMutationService.js'
import {
  acquireProjectRun,
  markProjectRunning,
  updateProjectOwned,
  updateGenerationJobOwned,
  insertProjectOwned,
  runProjectOwned,
  touchProjectLease,
  isProjectRunOwned,
} from '../services/projectAdmission.js'

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

async function startDubSequential(project, setProgress, results, signal, runToken = null, forceTranscript = false) {
  const projectId = project.id
  const params = parseParams(project.params)
  const useOcr = Boolean(params.ocrMode)
  const firstStage = useOcr ? 'dub.ocr' : 'dub.stt'

  await ensureStageJob(projectId, firstStage, runToken)
  await ensureStageJob(projectId, 'dub.merge', runToken)

  const firstJob = await loadJob(projectId, firstStage)
  const firstOk = await executeStage(
    project, firstJob, {},
    (pct) => {
      const p = Math.max(0, Math.min(99, Math.round(pct)))
      updateGenerationJobOwned(projectId, firstJob.id, { progress: p }, runToken).catch(() => {})
      eventBus.publish(projectId, { stage: firstStage, status: 'running', percent: p })
    },
    results,
    false,
    signal,
    runToken,
    forceTranscript
  )

  if (firstOk === 'waiting') return { status: 'waiting', stage: firstStage }
  if (!firstOk) return false

  const mergeJob = await loadJob(projectId, 'dub.merge')
  const mergeOk = await executeStage(
    project, mergeJob, {},
    (pct) => {
      const p = Math.max(0, Math.min(99, Math.round(pct)))
      updateGenerationJobOwned(projectId, mergeJob.id, { progress: p }, runToken).catch(() => {})
      eventBus.publish(projectId, { stage: 'dub.merge', status: 'running', percent: p })
    },
    results,
    false,
    signal,
    runToken,
    forceTranscript
  )
  if (mergeOk === 'waiting') return { status: 'waiting', stage: 'dub.merge' }
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

export function stagesForProject(projectOrMode) {
  const project = typeof projectOrMode === 'string' ? { mode: projectOrMode, params: '{}' } : (projectOrMode || {})
  const mode = String(project.mode || '').toUpperCase().replace('-', '_')
  if (mode !== 'TRANSLATE_DUB') return (STAGES[mode] || []).flat()
  const params = parseParams(project.params)
  return [
    'dub.ingest',
    params.ocrMode ? 'dub.ocr' : 'dub.stt',
    'dub.merge',
    'dub.translate',
    'dub.ttsAlign',
    'dub.render',
  ]
}

function groupedStagesForProject(project) {
  const order = stagesForProject(project)
  if (String(project?.mode || '').toUpperCase().replace('-', '_') !== 'TRANSLATE_DUB') return order.map((stage) => [stage])
  return [
    ['dub.ingest'],
    [order[1], 'dub.merge'],
    ['dub.translate'],
    ['dub.ttsAlign'],
    ['dub.render'],
  ]
}

export function flatStages(projectOrMode) {
  return stagesForProject(projectOrMode)
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
  'dub.ingest': ['audios', 'subtitles', 'outputs'],
  'dub.stt': ['audios', 'subtitles', 'outputs'],
  'dub.ocr': ['audios', 'subtitles', 'outputs'],

  'dub.merge': [], // dub.merge chỉ kiểm tra DB, không tạo artifacts
  'dub.translate': ['audios', 'subtitles', 'outputs'],
  'dub.ttsAlign': ['audios', 'outputs'],
  'dub.render': ['outputs'],
}

async function assertRunOwner(projectId, runToken) {
  if (runToken && !(await isProjectRunOwned(projectId, runToken))) {
    const error = new Error('RUN_ABORTED')
    error.code = 'RUN_ABORTED'
    throw error
  }
}

async function runOwnedSql(projectId, runToken, sql, params = []) {
  const updated = await runProjectOwned(projectId, runToken, sql, params)
  if (runToken && !updated) {
    const error = new Error('RUN_ABORTED')
    error.code = 'RUN_ABORTED'
    throw error
  }
  return updated
}

async function clearArtifacts(projectId, kinds, runToken = null) {
  const dir = projectDir(projectId)
  for (const kind of kinds) {
    await assertRunOwner(projectId, runToken)
    if (kind === 'transcript') {
      try { fs.unlinkSync(path.join(dir, 'transcript.json')) } catch (_) {}
    } else if (kind === 'transcriptSegments') {
      await clearTranscript(projectId, null, { runToken })
    } else if (kind === 'scenes') {
      await runOwnedSql(projectId, runToken, `DELETE FROM scenes WHERE project_id = ?`, [projectId])
      await assertRunOwner(projectId, runToken)
      fs.rmSync(path.join(dir, 'thumbs'), { recursive: true, force: true })
    } else if (kind === 'segments') {
      await runOwnedSql(projectId, runToken, `DELETE FROM script_segments WHERE project_id = ?`, [projectId])
    } else if (kind === 'clips') {
      await runOwnedSql(projectId, runToken, `DELETE FROM timeline_clips WHERE project_id = ?`, [projectId])
    } else if (kind === 'audios') {
      const rows = await query(`SELECT storage_key FROM audios WHERE project_id = ?`, [projectId])
      for (const r of rows) {
        await assertRunOwner(projectId, runToken)
        const abs = resolveStorageKey(r.storage_key)
        if (abs && abs.startsWith(dir)) {
          try { fs.unlinkSync(abs) } catch (_) {}
        }
      }
      await runOwnedSql(projectId, runToken, `DELETE FROM audios WHERE project_id = ?`, [projectId])
      await clearTtsLinks(projectId, null, { runToken })
    } else if (kind === 'subtitles') {
      await runOwnedSql(projectId, runToken, `DELETE FROM subtitles WHERE project_id = ?`, [projectId])
      await assertRunOwner(projectId, runToken)
      try { fs.unlinkSync(path.join(dir, 'subtitles.srt')) } catch (_) {}
      try { fs.unlinkSync(path.join(dir, 'subtitles.ass')) } catch (_) {}
    } else if (kind === 'outputs') {
      await runOwnedSql(
        projectId,
        runToken,
        `DELETE FROM youtube_uploads WHERE output_id IN (SELECT id FROM outputs WHERE project_id = ?)`,
        [projectId]
      )
      const rows = await query(
        `SELECT storage_key FROM outputs WHERE project_id = ? AND storage_key IS NOT NULL`,
        [projectId]
      )
      for (const r of rows) {
        await assertRunOwner(projectId, runToken)
        const abs = resolveStorageKey(r.storage_key)
        if (abs && !abs.startsWith(dir)) {
          try { fs.unlinkSync(abs) } catch (_) {}
        }
      }
      await runOwnedSql(projectId, runToken, `DELETE FROM outputs WHERE project_id = ?`, [projectId])
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

async function failJob(job, projectId, message, runToken = null) {
  const attempt = (job.attempts || 0) + 1
  const updated = await updateGenerationJobOwned(projectId, job.id, {
    status: 'failed',
    step: 'error',
    progress: 0,
    error_message: String(message).slice(0, 500),
  }, runToken)
  if (!updated) return false
  logStageFailure({ projectId, stage: job.type, errOrMessage: message, attempt })
  eventBus.publish(projectId, { stage: job.type, status: 'failed', percent: 0 })
  await logProviderCall({
    projectId,
    jobId: job.id,
    provider: STAGE_PROVIDER[job.type] || 'core',
    type: 'media',
    status: 'error',
    error: String(message).slice(0, 500),
  })
  return true
}

// Park a run halted by a rate-limit cooldown: mark the project queued so
// drainQueued (or a manual retry after next_retry_at) resumes from the
// earliest incomplete stage. Marking it failed would mislead; advancing
// would BLOCK_RENDER-fail downstream stages on missing artifacts.
async function parkProjectForRetry(projectId, stageType, runToken) {
  if (runToken) {
    const parked = await updateProjectOwned(projectId, runToken, {
      status: 'queued',
      run_token: null,
      lease_expires_at: null,
    })
    if (!parked) return false
  }
  eventBus.publish(projectId, { stage: stageType, status: 'retry', percent: 0 })
  return true
}

async function ensureStageJob(projectId, type, runToken = null) {
  await assertRunOwner(projectId, runToken)
  const existing = await queryOne(
    'SELECT id, payload FROM generation_jobs WHERE project_id = ? AND type = ?',
    [projectId, type]
  )
  const payload = runToken ? JSON.stringify({ runToken }) : null
  if (!existing) {
    const created = await insertProjectOwned(projectId, runToken, 'generation_jobs', {
      id: uuidv4(),
      project_id: projectId,
      type,
      status: 'pending',
      attempts: 0,
      payload,
    })
    if (runToken && !created) {
      const error = new Error('RUN_ABORTED')
      error.code = 'RUN_ABORTED'
      throw error
    }
  } else if (runToken && existing.payload !== payload) {
    await updateGenerationJobOwned(projectId, existing.id, { payload }, runToken)
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
async function executeStage(project, job, settings, setProgress, results, isFirstExecutedStage, signal, runToken = null, forceTranscript = false) {
  const projectId = project.id
  try {
    if (runToken && !(await isProjectRunOwned(projectId, runToken))) return false
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

    if (job.status !== 'pending' && job.status !== 'retry') {
      const resetUpdated = await updateGenerationJobOwned(projectId, job.id, { status: 'pending', error_message: null }, runToken)
      if (!resetUpdated) return false
    }
    const startedUpdated = await updateGenerationJobOwned(projectId, job.id, {
      status: 'running',
      step: 'processing',
      attempts: (job.attempts || 0) + 1,
      progress: 0,
    }, runToken)
    if (!startedUpdated) return false
    await clearArtifacts(projectId, RESETS[job.type] || [], runToken)
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
        const currentVersion = await queryOne('SELECT transcript_version FROM projects WHERE id = ?', [projectId])
        await dedupeTranscriptSegments(projectId, Number(currentVersion?.transcript_version ?? project.transcript_version ?? 0), { runToken })
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
        await failJob(job, projectId, errorMsg, runToken)
        return false
      }
    }

    const impl = STAGE_IMPL[job.type]
    if (!impl) throw new Error(`Stage không được hỗ trợ: ${job.type}`)
    const stageTimeout = STAGE_TIMEOUTS[job.type] || DEFAULT_STAGE_TIMEOUT
    let transcriptVersion = null
    if (job.type === 'dub.render') {
      const current = await queryOne('SELECT transcript_version FROM projects WHERE id = ?', [projectId])
      transcriptVersion = Number(current?.transcript_version ?? project.transcript_version ?? 0)
      await updateGenerationJobOwned(projectId, job.id, {
        payload: JSON.stringify({ runToken, transcriptVersion }),
      }, runToken)
    }
    const result = await withTimeout(
      impl({ project, job, settings, setProgress, results, signal, runToken, transcriptVersion, forceTranscript }),
      stageTimeout,
      job.type
    )
    results[job.type] = result

    const updated = await updateGenerationJobOwned(projectId, job.id, {
      status: 'success',
      step: 'done',
      progress: 100,
      result: JSON.stringify(result || {}),
    }, runToken)
    if (!updated) return false
    eventBus.publish(projectId, { stage: job.type, status: 'success', percent: 100 })
    return true
  } catch (err) {
    if (err?.code === 'RUN_ABORTED') return false
    // Validation fail fast trước mọi xử lý retry: lỗi dữ liệu không tự khỏi
    // theo thời gian, retry cùng input chỉ spam log (từng lặp 5x BLOCK_RENDER).
    if (isValidationError(err)) {
      await failJob(job, projectId, err.message, runToken)
      return false
    }
    if (isRateLimitError(err)) {
      // Rate-limited: retry with scheduled nextRetryAt (docs/11 §4.2)
      const MAX_RATE_LIMIT_RETRIES = 5
      const attempts = (job.attempts || 0) + 1

      if (attempts >= MAX_RATE_LIMIT_RETRIES) {
        await failJob(job, projectId, `PROV_002: Tất cả key cho provider đã hết quota sau ${attempts} lần retry`, runToken)
        return false
      }

      const retryAfter = parseRetryAfter(err)
      const nextRetryAt = retryAfter
        ? new Date(Date.now() + retryAfter * 1000).toISOString()
        : await getNextRetryAt(STAGE_PROVIDER[job.type] || 'unknown')

      const retryUpdated = await updateGenerationJobOwned(projectId, job.id, {
        status: 'retry',
        step: 'rate_limited',
        attempts,
        next_retry_at: nextRetryAt,
        error_message: `Rate limited: ${err.message}`,
      }, runToken)
      if (!retryUpdated) return false
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
      let kind = err?.transient || err?.code === 'DB_WRITE_QUEUE_FULL' ? ERROR_KINDS.TRANSIENT : null
      if (!kind) {
        try {
          kind = classifyProviderError(err).kind
        } catch (_) {}
      }
      if (kind === ERROR_KINDS.TRANSIENT) {
        const policy = RETRY_POLICY[job.type] || { maxRetries: 2, backoffMs: [10_000, 30_000] }
        const attempts = (job.attempts || 0) + 1
        if (attempts <= policy.maxRetries) {
          const delayMs = policy.backoffMs[Math.min(attempts - 1, policy.backoffMs.length - 1)]
          const nextRetryAt = new Date(Date.now() + delayMs).toISOString()
          const retryUpdated = await updateGenerationJobOwned(projectId, job.id, {
            status: 'retry',
            step: 'transient',
            attempts,
            next_retry_at: nextRetryAt,
            error_message: `Transient: ${String(err.message).slice(0, 400)}`,
          }, runToken)
          if (!retryUpdated) return false
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

    await failJob(job, projectId, err.message, runToken)
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
export async function touchHeartbeat(projectId, runToken = null) {
  try {
    const token = runToken || (await queryOne('SELECT run_token FROM projects WHERE id = ? AND status = ?', [projectId, 'running']))?.run_token
    if (token) await touchProjectLease(projectId, token)
    else await run(
      `UPDATE projects SET last_heartbeat_at = ? WHERE id = ? AND status = 'running'`,
      [nowIso(), projectId],
      { op: 'project.heartbeat' }
    )
  } catch (_) {}
}

export function abortPipeline(projectId) {
  const ac = abortControllers.get(projectId)
  if (ac) ac.abort()
}

const startingRuns = new Set()

export async function runPipeline(projectId, fromStage = null, admissionToken = null, options = {}) {
  if (activeRuns.has(projectId) || startingRuns.has(projectId)) return
  startingRuns.add(projectId)
  try {
    return await runPipelineOwned(projectId, fromStage, admissionToken, options)
  } finally {
    startingRuns.delete(projectId)
  }
}

async function runPipelineOwned(projectId, fromStage = null, admissionToken = null, options = {}) {
  if (activeRuns.has(projectId)) return
  let runToken = admissionToken
  if (!runToken) {
    const admission = await acquireProjectRun(projectId, { allowReserved: true })
    if (!admission.admitted) return admission
    runToken = admission.runToken
  }
  let project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  if (!project || project.run_token !== runToken || project.status !== 'pending') return { admitted: false, reason: 'not-owner' }

  const started = await markProjectRunning(projectId, runToken)
  if (!started) return { admitted: false, reason: 'not-owner' }
  project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  if (!project) {
    await updateProjectOwned(projectId, runToken, { status: 'queued', run_token: null, lease_expires_at: null })
    return
  }

  activeRuns.add(projectId)

  // Create AbortController for this pipeline run
  const abortController = new AbortController()
  abortControllers.set(projectId, abortController)
  const { signal } = abortController
  const heartbeatTimer = setInterval(() => {
    touchHeartbeat(projectId, runToken)
  }, 30_000)
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()

  try {
    const stageGroups = groupedStagesForProject(project)
    for (const group of stageGroups) {
      const list = Array.isArray(group) ? group : [group]
      for (const type of list) await ensureStageJob(projectId, type, runToken)
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
        const r = firstRunnableStage(stagesForProject(project), allJobs)
        if (r.waiting) {
          await parkProjectForRetry(projectId, r.type, runToken)
          return
        }
        if (r.type && r.type !== effectiveFrom) {
          console.warn(`[Pipeline] Clamped resume ${effectiveFrom} → ${r.type} (earliest incomplete) for ${projectId}`)
          effectiveFrom = r.type
        }
      } catch (_) {}
    }

    await updateProjectOwned(projectId, runToken, { progress: 0, last_heartbeat_at: nowIso() })
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
            updateGenerationJobOwned(projectId, job.id, { progress: p }, runToken).catch(() => {})
            eventBus.publish(projectId, { stage: job.type, status: 'running', percent: p })
          },
          results,
          isFirstExecutedStage,
          signal,
          runToken,
          options.forceTranscript === true
        )
        isFirstExecutedStage = false
        if (ok === 'waiting') {
          await parkProjectForRetry(projectId, types[0], runToken)
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
          signal,
          runToken,
          options.forceTranscript === true
        )
        isFirstExecutedStage = false
        if (ok === 'waiting' || ok?.status === 'waiting') {
          await parkProjectForRetry(projectId, ok?.stage || 'dub.stt', runToken)
          return
        }
        if (!ok) groupFailed = true
      }

      if (groupFailed) {
        const failedUpdated = await updateProjectOwned(projectId, runToken, { status: 'failed', run_token: null, lease_expires_at: null })
        if (failedUpdated) eventBus.publish(projectId, { stage: '__project__', status: 'failed', percent: done / total * 100 })
        return
      }

      done++
      const progressed = await updateProjectOwned(projectId, runToken, {
        progress: Math.round((done / total) * 100),
        last_heartbeat_at: nowIso(),
      })
      if (!progressed) return
      eventBus.publish(projectId, {
        stage: '__project__',
        status: done >= total ? 'completed' : 'running',
        percent: Math.round((done / total) * 100),
      })
      currentProject = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId]) || currentProject
    }

    const completedUpdated = await updateProjectOwned(projectId, runToken, { status: 'completed', progress: 100, run_token: null, lease_expires_at: null })
    if (!completedUpdated) return
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
    if (err?.code === 'RUN_ABORTED') return
    console.error('[Pipeline] lỗi:', err)
    const failedUpdated = await updateProjectOwned(projectId, runToken, { status: 'failed', run_token: null, lease_expires_at: null })
    if (!failedUpdated) return
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
    clearInterval(heartbeatTimer)
    activeRuns.delete(projectId)
    abortControllers.delete(projectId)
  }
}

export default { runPipeline, STAGES, flatStages, stagesForProject }
