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
import dubTranslate from './stages/dubTranslate.js'
import dubTtsAlign from './stages/dubTtsAlign.js'
import dubRender from './stages/dubRender.js'

// Stage lists mirror docs/01 §3 + docs/05 §B.
// A nested array marks a PARALLEL GROUP: members run concurrently via Promise.all
// (docs/05 §B.0 — dub.stt ‖ dub.ocr độc lập dữ liệu).
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
    ['dub.stt', 'dub.ocr'],
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
  // TRANSLATE_DUB (docs/02: TranscriptSegment / OcrRegion riêng cho từng mode)
  'dub.ingest': ['transcriptSegments', 'ocrRegions', 'audios', 'subtitles', 'outputs'],
  'dub.stt': ['transcriptSegments', 'audios', 'subtitles', 'outputs'],
  'dub.ocr': ['ocrRegions', 'outputs'],
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
    } else if (kind === 'ocrRegions') {
      await run(`DELETE FROM ocr_regions WHERE project_id = ? AND source != 'MANUAL'`, [projectId])
      fs.rmSync(path.join(dir, 'frames'), { recursive: true, force: true })
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

async function failJob(job, projectId, message) {
  console.error(`[Pipeline] stage ${job.type} thất bại cho ${projectId}: ${message}`)
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

// Execute ONE stage end-to-end (reset → running → impl → success/fail).
// Trả về true nếu thành công/skip, false nếu thất bại.
async function executeStage(project, job, settings, setProgress, results, isFirstExecutedStage) {
  const projectId = project.id
  try {
    await clearArtifacts(projectId, RESETS[job.type] || [])

    if (job.status !== 'pending') {
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

    const impl = STAGE_IMPL[job.type]
    if (!impl) throw new Error(`Stage không được hỗ trợ: ${job.type}`)
    const result = await impl({ project, job, settings, setProgress, results })
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
    await failJob(job, projectId, err.message)
    return false
  }
}

const activeRuns = new Set()

export function isPipelineRunning(projectId) {
  return activeRuns.has(projectId)
}

export async function runPipeline(projectId, fromStage = null) {
  if (activeRuns.has(projectId)) return
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  if (!project) return
  activeRuns.add(projectId)

  try {
    const stageGroups = STAGES[project.mode] || []
    for (const group of stageGroups) {
      const list = Array.isArray(group) ? group : [group]
      for (const type of list) await ensureStageJob(projectId, type)
    }

    await updateById('projects', projectId, { status: 'running', progress: 0 })
    eventBus.publish(projectId, { stage: '__project__', status: 'running', percent: 0 })

    let started = !fromStage
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
        if (types.includes(fromStage)) started = true
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
          isFirstExecutedStage
        )
        isFirstExecutedStage = false
        if (!ok) groupFailed = true
      } else {
        // Nhóm song song (docs/05 §B.0): dub.stt ‖ dub.ocr chạy Promise.all
        const jobs = []
        for (const type of types) jobs.push(await loadJob(projectId, type))
        const tasks = jobs.map((job) =>
          executeStage(
            currentProject, job, settings,
            (pct) => {
              const p = Math.max(0, Math.min(99, Math.round(pct)))
              updateById('generation_jobs', job.id, { progress: p }).catch(() => {})
              eventBus.publish(projectId, { stage: job.type, status: 'running', percent: p })
            },
            results,
            false
          ).then((ok) => ({ job, ok }))
        )
        const settled = await Promise.all(tasks)
        isFirstExecutedStage = false
        if (settled.some((s) => !s.ok)) groupFailed = true
      }

      if (groupFailed) {
        await updateById('projects', projectId, { status: 'failed' })
        eventBus.publish(projectId, { stage: '__project__', status: 'failed', percent: done / total * 100 })
        return
      }

      done++
      await updateById('projects', projectId, {
        progress: Math.round((done / total) * 100),
      })
      eventBus.publish(projectId, {
        stage: '__project__',
        status: done >= total ? 'success' : 'running',
        percent: Math.round((done / total) * 100),
      })
      currentProject = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId]) || currentProject
    }

    await updateById('projects', projectId, { status: 'completed', progress: 100 })
    eventBus.publish(projectId, { stage: '__project__', status: 'success', percent: 100 })
  } catch (err) {
    console.error('[Pipeline] lỗi:', err)
    await updateById('projects', projectId, { status: 'failed' })
    eventBus.publish(projectId, { stage: '__project__', status: 'failed', percent: 0 })
  } finally {
    activeRuns.delete(projectId)
  }
}

export default { runPipeline, STAGES, flatStages }
