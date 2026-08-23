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

import summaryTranscribe from './stages/summaryTranscribe.js'
import summarySceneDetect from './stages/summarySceneDetect.js'
import summaryAnalyze from './stages/summaryAnalyze.js'
import summaryScript from './stages/summaryScript.js'
import summaryAlign from './stages/summaryAlign.js'
import summaryTts from './stages/summaryTts.js'
import summarySubtitle from './stages/summarySubtitle.js'
import summaryRender from './stages/summaryRender.js'
import styleAnalyze from './stages/styleAnalyze.js'
import styleStoryboard from './stages/styleStoryboard.js'
import styleTts from './stages/styleTts.js'
import styleRender from './stages/styleRender.js'

// Stage lists mirror docs/01 §5; frontend vocabulary stays lowercase.
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
  STYLE_EDIT: [
    'style.analyze',
    'style.storyboard',
    'style.tts',
    'style.render',
  ],
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
  'style.analyze': styleAnalyze,
  'style.storyboard': styleStoryboard,
  'style.tts': styleTts,
  'style.render': styleRender,
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
  'style.analyze': 'ffmpeg',
  'style.storyboard': 'llm',
  'style.tts': 'tts',
  'style.render': 'ffmpeg',
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
  'style.analyze': ['clips', 'audios', 'outputs'],
  'style.storyboard': ['clips', 'audios', 'outputs'],
  'style.tts': ['audios', 'outputs'],
  'style.render': ['outputs'],
}

async function clearArtifacts(projectId, kinds) {
  const dir = projectDir(projectId)
  for (const kind of kinds) {
    if (kind === 'transcript') {
      try { fs.unlinkSync(path.join(dir, 'transcript.json')) } catch (_) {}
      try { fs.unlinkSync(path.join(dir, 'style_profile.json')) } catch (_) {}
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
    } else if (kind === 'subtitles') {
      await run(`DELETE FROM subtitles WHERE project_id = ?`, [projectId])
      try { fs.unlinkSync(path.join(dir, 'subtitles.srt')) } catch (_) {}
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
  const keys =
    project.mode === 'SUMMARY' ? [project.source_video_key] : [project.template_video_key]
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
  await logProviderCall({
    projectId,
    jobId: job.id,
    provider: STAGE_PROVIDER[job.type] || 'core',
    type: 'media',
    status: 'error',
    error: String(message).slice(0, 500),
  })
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
    const stages = STAGES[project.mode] || []

    for (const type of stages) {
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

    await updateById('projects', projectId, { status: 'running', progress: 0 })

    let started = !fromStage
    let isFirstExecutedStage = true
    const total = stages.length
    let done = 0

    const priorJobs = await query('SELECT type, result FROM generation_jobs WHERE project_id = ?', [projectId])
    const results = {}
    for (const j of priorJobs) {
      const parsed = parseJsonSafe(j.result)
      if (parsed) results[j.type] = parsed
    }

    const settings = await getUserSettings(project.user_id)

    for (const type of stages) {
      const job = await queryOne(
        'SELECT * FROM generation_jobs WHERE project_id = ? AND type = ?',
        [projectId, type]
      )
      if (!started) {
        if (job.type === fromStage) started = true
        else continue
      }

      await clearArtifacts(projectId, RESETS[type] || [])

      if (job.status !== 'pending') {
        await updateById('generation_jobs', job.id, { status: 'pending', error_message: null })
      }
      await updateById('generation_jobs', job.id, {
        status: 'running',
        step: 'processing',
        attempts: (job.attempts || 0) + 1,
        progress: 0,
      })

      const setProgress = (pct) => {
        const p = Math.max(0, Math.min(99, Math.round(pct)))
        updateById('generation_jobs', job.id, { progress: p }).catch(() => {})
      }

      try {
        if (isFirstExecutedStage) {
          isFirstExecutedStage = false
          checkInputs(project)
        }

        const impl = STAGE_IMPL[type]
        if (!impl) throw new Error(`Stage không được hỗ trợ: ${type}`)
        const result = await impl({ project, job, settings, setProgress, results })
        results[type] = result

        await updateById('generation_jobs', job.id, {
          status: 'success',
          step: 'done',
          progress: 100,
          result: JSON.stringify(result || {}),
        })
        done++
        await updateById('projects', projectId, {
          progress: Math.round((done / total) * 100),
        })
      } catch (err) {
        await failJob(job, projectId, err.message)
        await updateById('projects', projectId, { status: 'failed' })
        return
      }
    }

    await updateById('projects', projectId, { status: 'completed', progress: 100 })
  } catch (err) {
    console.error('[Pipeline] lỗi:', err)
    await updateById('projects', projectId, { status: 'failed' })
  } finally {
    activeRuns.delete(projectId)
  }
}

export default { runPipeline, STAGES }
