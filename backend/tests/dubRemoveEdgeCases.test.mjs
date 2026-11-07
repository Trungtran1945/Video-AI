import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { once } from 'node:events'
import express from 'express'
import { v4 as uuidv4 } from 'uuid'

const tmpDb = path.join(os.tmpdir(), `vidai_dub_edge_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)
const tmpStorage = path.join(os.tmpdir(), `vidai_dub_edge_storage_${Date.now()}_${Math.random().toString(36).slice(2)}`)
process.env.DB_PATH = tmpDb
process.env.STORAGE_DIR = tmpStorage
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const { insert, run, queryOne, query } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const projectsRouter = (await import('../src/routes/v1/projects.js')).default
const runner = await import('../src/pipeline/runner.js')
const { connection } = await import('../src/queue/connection.js')
const { notifyQueue } = await import('../src/queue/notifyQueue.js')

await initSchema()
try { connection.disconnect() } catch (_) {}
try { notifyQueue.close() } catch (_) {}

fs.mkdirSync(path.join(tmpStorage, 'uploads'), { recursive: true })
fs.writeFileSync(path.join(tmpStorage, 'uploads', 'src_edge.mp4'), 'dummy video content')

const app = express()
app.use(express.json())
app.use('/api/v1/projects', projectsRouter)
const server = app.listen(0)
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}/api/v1/projects`

let failures = 0
const assert = (condition, msg) => {
  if (condition) {
    console.log(`PASS: ${msg}`)
  } else {
    failures++
    console.error(`FAIL: ${msg}`)
  }
}

try {
  const userId = uuidv4()
  await insert('users', {
    id: userId,
    email: 'user_edge@test.local',
    password: 'hash',
    role: 'user',
    created_date: new Date().toISOString(),
  })
  const token = generateAccessToken({ id: userId, role: 'user', email: 'user_edge@test.local' })

  // EDGE 1: snake_case enable_dubbing in params
  console.log('\n--- EDGE 1: snake_case and string parameter variations ---')
  const stagesSnake = runner.stagesForProject({ mode: 'TRANSLATE_DUB', params: { enable_dubbing: false } })
  assert(stagesSnake.length === 6 && !stagesSnake.includes('dub.ttsAlign'), 'enable_dubbing: false correctly excludes dub.ttsAlign')

  const stagesStringFalse = runner.stagesForProject({ mode: 'TRANSLATE_DUB', params: { enableDubbing: 'false' } })
  assert(stagesStringFalse.length === 6 && !stagesStringFalse.includes('dub.ttsAlign'), 'enableDubbing: "false" string correctly excludes dub.ttsAlign')

  const stagesAudioModeOnly = runner.stagesForProject({ mode: 'TRANSLATE_DUB', params: { enableDubbing: true, audioMode: 'ORIGINAL_ONLY' } })
  assert(stagesAudioModeOnly.length === 6 && !stagesAudioModeOnly.includes('dub.ttsAlign'), 'enableDubbing: true with audioMode: ORIGINAL_ONLY excludes dub.ttsAlign')

  // EDGE 2: Request invalid stage dub.ttsAlign via regenerate when dubbing is disabled
  console.log('\n--- EDGE 2: Rejecting dub.ttsAlign in regenerate when dubbing disabled ---')
  const pEdge1 = uuidv4()
  await insert('projects', {
    id: pEdge1,
    user_id: userId,
    mode: 'TRANSLATE_DUB',
    title: 'Edge 1 Project',
    status: 'failed',
    transcript_version: 1,
    source_video_key: 'uploads/src_edge.mp4',
    params: JSON.stringify({ enableDubbing: false }),
  })

  const regenInvalid = await fetch(`${base}/${pEdge1}/regenerate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fromStage: 'dub.ttsAlign' }),
  })
  assert(regenInvalid.status === 400, `POST /regenerate with disabled dub.ttsAlign returns 400 Bad Request (got ${regenInvalid.status})`)
  const invalidBody = await regenInvalid.json()
  assert(invalidBody.error?.message?.includes('dub.ttsAlign'), 'Error message identifies invalid stage')

  // EDGE 3: Completed project -> switch to enableDubbing: false -> regenerate
  console.log('\n--- EDGE 3: Completed project rerun with dubbing removed ---')
  const pEdge2 = uuidv4()
  await insert('projects', {
    id: pEdge2,
    user_id: userId,
    mode: 'TRANSLATE_DUB',
    title: 'Completed Project To Redo As Original Audio',
    status: 'completed',
    transcript_version: 2,
    source_video_key: 'uploads/src_edge.mp4',
    params: JSON.stringify({ enableDubbing: true, voiceProvider: 'edge_tts' }),
  })
  for (const st of ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.mask', 'dub.ttsAlign']) {
    await insert('generation_jobs', {
      id: uuidv4(),
      project_id: pEdge2,
      type: st,
      status: 'success',
    })
  }
  await insert('generation_jobs', {
    id: uuidv4(),
    project_id: pEdge2,
    type: 'dub.render',
    status: 'success',
    result: JSON.stringify({ output: 'old_dubbed.mp4' }),
  })

  // Disable dubbing
  for (let i = 0; i < 3; i++) {
    await insert('transcript_segments', {
      id: uuidv4(),
      project_id: pEdge2,
      index_num: i,
      start_sec: i * 2,
      end_sec: (i + 1) * 2,
      text: `Source text ${i}`,
      translation: `Dịch văn bản ${i}`,
      tts_audio_id: uuidv4(),
      tts_clip_key: `audio_segments/seg_${i}.mp3`,
    })
  }

  const patchEdge = await fetch(`${base}/${pEdge2}/dubbing`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ enableDubbing: false }),
  })
  assert(patchEdge.status === 200, 'PATCH /dubbing success')

  const renderJobReset = await queryOne('SELECT status FROM generation_jobs WHERE project_id = ? AND type = ?', [pEdge2, 'dub.render'])
  assert(renderJobReset?.status === 'pending', 'dub.render was reset to pending')

  let edge2RenderRan = false
  runner.setStageImplOverride('dub.render', async () => {
    edge2RenderRan = true
    return { outputKey: 'outputs/edge2_final.mp4' }
  })

  // Calling regenerate without stage
  const regenEdge2 = await fetch(`${base}/${pEdge2}/regenerate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  const edge2Body = await regenEdge2.json()
  assert(regenEdge2.status === 200, `POST /regenerate returns 200 (not 409 ALREADY_COMPLETED) (got ${regenEdge2.status})`)
  assert(edge2Body.fromStage === 'dub.render', `Auto-selected dub.render as earliest runnable stage (got ${edge2Body.fromStage})`)

  for (let i = 0; i < 30; i++) {
    const pCheck = await queryOne('SELECT status FROM projects WHERE id = ?', [pEdge2])
    if (pCheck.status === 'completed') break
    await new Promise((r) => setTimeout(r, 100))
  }
  const pEdge2Final = await queryOne('SELECT status FROM projects WHERE id = ?', [pEdge2])
  assert(pEdge2Final.status === 'completed', 'Project re-completed successfully')
  assert(edge2RenderRan, 'dub.render executed for original-only rerun')

  // EDGE 4: Multiple segments without tts_audio_id, ensure resolveGenerationSnapshot returns current version
  console.log('\n--- EDGE 4: Multiple segments and snapshot resolution ---')
  for (let i = 0; i < 5; i++) {
    await insert('transcript_segments', {
      id: uuidv4(),
      project_id: pEdge2,
      index_num: i,
      start_sec: i * 2,
      end_sec: (i + 1) * 2,
      text: `Source text ${i}`,
      translation: `Dịch văn bản ${i}`,
      tts_audio_id: null,
      tts_clip_key: null,
    })
  }
  const snapRev = await runner.resolveGenerationSnapshot(pEdge2, 'dub.render', { mode: 'TRANSLATE_DUB', params: { enableDubbing: false } })
  assert(snapRev === 2, `Snapshot resolved current transcript_version (2), got ${snapRev}`)

} catch (err) {
  console.error('Edge test error:', err)
  failures++
} finally {
  runner.clearStageImplOverrides()
  server.close()
  try { fs.rmSync(tmpDb, { force: true }) } catch (_) {}
  try { fs.rmSync(tmpStorage, { recursive: true, force: true }) } catch (_) {}
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertions failed in edge cases.`)
  process.exit(1)
} else {
  console.log('\nALL PASS: dubRemoveEdgeCases suite passed completely!')
  process.exit(0)
}
