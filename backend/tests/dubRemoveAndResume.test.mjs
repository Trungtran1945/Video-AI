import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { once } from 'node:events'
import express from 'express'
import { v4 as uuidv4 } from 'uuid'

const tmpDb = path.join(os.tmpdir(), `vidai_dub_remove_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)
const tmpStorage = path.join(os.tmpdir(), `vidai_dub_remove_storage_${Date.now()}_${Math.random().toString(36).slice(2)}`)
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
fs.writeFileSync(path.join(tmpStorage, 'uploads', 'p2_src.mp4'), 'dummy video content')
fs.writeFileSync(path.join(tmpStorage, 'uploads', 'p3_src.mp4'), 'dummy video content')

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
  // Setup user
  const userId = uuidv4()
  await insert('users', {
    id: userId,
    email: 'user_dub@test.local',
    password: 'hash',
    role: 'user',
    created_date: new Date().toISOString(),
  })
  const token = generateAccessToken({ id: userId, role: 'user', email: 'user_dub@test.local' })

  // ── TEST 1: stagesForProject dynamic stages (AC-DUB01, AC-DUB02) ──────────
  console.log('\n--- TEST 1: stagesForProject dynamic stages ---')
  const defaultDub = runner.stagesForProject('TRANSLATE_DUB')
  assert(defaultDub.length === 7 && defaultDub.includes('dub.ttsAlign'), 'Default TRANSLATE_DUB has 7 stages including dub.ttsAlign')

  const dubWithEnabled = runner.stagesForProject({ mode: 'TRANSLATE_DUB', params: { enableDubbing: true } })
  assert(dubWithEnabled.length === 7 && dubWithEnabled.includes('dub.ttsAlign'), 'enableDubbing: true has 7 stages')

  const dubDisabled = runner.stagesForProject({ mode: 'TRANSLATE_DUB', params: { enableDubbing: false } })
  assert(dubDisabled.length === 6 && !dubDisabled.includes('dub.ttsAlign'), 'enableDubbing: false has 6 stages (dub.ttsAlign excluded)')
  assert(dubDisabled[5] === 'dub.render', 'Last stage of disabled dubbing is dub.render')

  const dubOriginalOnly = runner.stagesForProject({ mode: 'TRANSLATE_DUB', params: { audioMode: 'ORIGINAL_ONLY' } })
  assert(dubOriginalOnly.length === 6 && !dubOriginalOnly.includes('dub.ttsAlign'), 'audioMode: ORIGINAL_ONLY has 6 stages (dub.ttsAlign excluded)')

  const dubDisabledStringParams = runner.stagesForProject({
    mode: 'TRANSLATE_DUB',
    params: JSON.stringify({ enableDubbing: false }),
  })
  assert(dubDisabledStringParams.length === 6 && !dubDisabledStringParams.includes('dub.ttsAlign'), 'Stringified params enableDubbing: false parsed correctly')

  const groupsEnabled = runner.groupedStagesForProject({ mode: 'TRANSLATE_DUB', params: { enableDubbing: true } })
  const hasTtsGroup = groupsEnabled.some((g) => g.includes('dub.ttsAlign'))
  assert(hasTtsGroup, 'groupedStagesForProject has dub.ttsAlign group when dubbing is enabled')

  const groupsDisabled = runner.groupedStagesForProject({ mode: 'TRANSLATE_DUB', params: { enableDubbing: false } })
  const hasTtsGroupDisabled = groupsDisabled.some((g) => g.includes('dub.ttsAlign'))
  assert(!hasTtsGroupDisabled, 'groupedStagesForProject excludes dub.ttsAlign group when dubbing is disabled')

  // ── TEST 2: resolveGenerationSnapshot with disabled dubbing (AC-DUB05) ────
  console.log('\n--- TEST 2: resolveGenerationSnapshot ---')
  const pSnapshotId = uuidv4()
  await insert('projects', {
    id: pSnapshotId,
    user_id: userId,
    mode: 'TRANSLATE_DUB',
    title: 'Snapshot Test',
    status: 'failed',
    transcript_version: 5,
    params: JSON.stringify({ enableDubbing: false }),
  })
  const resolvedRev = await runner.resolveGenerationSnapshot(
    pSnapshotId,
    'dub.render',
    { mode: 'TRANSLATE_DUB', params: { enableDubbing: false } }
  )
  assert(resolvedRev === 5, `resolveGenerationSnapshot returns current revision directly (got ${resolvedRev})`)

  // ── TEST 3: PATCH /dubbing removes failed dub.ttsAlign and resets dub.render (AC-DUB03) ──
  console.log('\n--- TEST 3: PATCH /dubbing cleanup ---')
  const p1Id = uuidv4()
  await insert('projects', {
    id: p1Id,
    user_id: userId,
    mode: 'TRANSLATE_DUB',
    title: 'Failed Dub Project',
    status: 'failed',
    transcript_version: 1,
    source_video_key: 'uploads/p1_src.mp4',
    params: JSON.stringify({ enableDubbing: true, voiceProvider: 'edge_tts' }),
  })

  // Create prior successful stages
  const priorStages = ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.mask']
  for (const st of priorStages) {
    await insert('generation_jobs', {
      id: uuidv4(),
      project_id: p1Id,
      type: st,
      status: 'success',
    })
  }
  // Failed dub.ttsAlign job
  await insert('generation_jobs', {
    id: uuidv4(),
    project_id: p1Id,
    type: 'dub.ttsAlign',
    status: 'failed',
    error_message: 'TTS_QUOTA_EXCEEDED: out of credits',
  })
  // Existing render job (e.g. from an old run)
  await insert('generation_jobs', {
    id: uuidv4(),
    project_id: p1Id,
    type: 'dub.render',
    status: 'success',
    result: JSON.stringify({ output: 'old.mp4' }),
  })

  // Audio row and transcript segment
  const audioId = uuidv4()
  await insert('audios', {
    id: audioId,
    project_id: p1Id,
    kind: 'voice',
    duration_sec: 2.5,
    provider: 'edge_tts',
  })
  const segId = uuidv4()
  await insert('transcript_segments', {
    id: segId,
    project_id: p1Id,
    index_num: 0,
    start_sec: 0,
    end_sec: 2.5,
    text: 'Hello world',
    translation: 'Xin chào thế giới',
    tts_audio_id: audioId,
    tts_clip_key: 'audio_segments/seg_0.mp3',
  })

  // Call PATCH /dubbing with enableDubbing: false
  const patchRes = await fetch(`${base}/${p1Id}/dubbing`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ enableDubbing: false }),
  })
  const patchBody = await patchRes.json()
  assert(patchRes.status === 200, `PATCH /dubbing returns 200 (got ${patchRes.status})`)
  assert(patchBody.params?.enableDubbing === false, 'params.enableDubbing updated to false')
  assert(patchBody.params?.audioMode === 'ORIGINAL_ONLY', 'params.audioMode updated to ORIGINAL_ONLY')

  // Verify DB state
  const ttsJob = await queryOne('SELECT * FROM generation_jobs WHERE project_id = ? AND type = ?', [p1Id, 'dub.ttsAlign'])
  assert(!ttsJob, 'dub.ttsAlign job was deleted from generation_jobs')

  const audioCount = await query('SELECT * FROM audios WHERE project_id = ?', [p1Id])
  assert(audioCount.length === 0, 'audios rows were deleted')

  const updatedSeg = await queryOne('SELECT * FROM transcript_segments WHERE id = ?', [segId])
  assert(updatedSeg.tts_audio_id === null, 'transcript_segments.tts_audio_id was cleared to NULL')
  assert(updatedSeg.tts_clip_key === null, 'transcript_segments.tts_clip_key was cleared to NULL')

  const renderJob = await queryOne('SELECT * FROM generation_jobs WHERE project_id = ? AND type = ?', [p1Id, 'dub.render'])
  assert(renderJob?.status === 'pending', 'dub.render job was reset to pending')
  assert(renderJob?.result === null, 'dub.render result was reset to null')
  assert(renderJob?.error_message === null, 'dub.render error_message was reset to null')

  // ── TEST 4: Regenerate resumes from dub.render without 429 quota block (AC-DUB04) ──
  console.log('\n--- TEST 4: Regenerate after removing rate-limited dub.ttsAlign ---')
  const p2Id = uuidv4()
  await insert('projects', {
    id: p2Id,
    user_id: userId,
    mode: 'TRANSLATE_DUB',
    title: 'Retry Blocked Project',
    status: 'failed',
    transcript_version: 1,
    source_video_key: 'uploads/p2_src.mp4',
    params: JSON.stringify({ enableDubbing: true, voiceProvider: 'elevenlabs' }),
  })
  for (const st of priorStages) {
    await insert('generation_jobs', {
      id: uuidv4(),
      project_id: p2Id,
      type: st,
      status: 'success',
    })
  }
  // Cooldown job in future
  const futureRetry = new Date(Date.now() + 300_000).toISOString()
  await insert('generation_jobs', {
    id: uuidv4(),
    project_id: p2Id,
    type: 'dub.ttsAlign',
    status: 'retry',
    next_retry_at: futureRetry,
  })
  await insert('transcript_segments', {
    id: uuidv4(),
    project_id: p2Id,
    index_num: 0,
    start_sec: 0,
    end_sec: 1.5,
    text: 'Rate limited text',
    translation: 'Văn bản chờ quota',
  })

  // Call PATCH /dubbing to disable dubbing
  const patchRes2 = await fetch(`${base}/${p2Id}/dubbing`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ enableDubbing: false }),
  })
  assert(patchRes2.status === 200, 'PATCH /dubbing success on rate-limited project')

  // Intercept dub.render execution
  let renderRan = false
  runner.setStageImplOverride('dub.render', async () => {
    renderRan = true
    return { outputKey: 'outputs/final.mp4' }
  })

  // Call POST /regenerate without fromStage
  const regenRes2 = await fetch(`${base}/${p2Id}/regenerate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  const regenBody2 = await regenRes2.json()
  assert(regenRes2.status === 200, `POST /regenerate returns 200, not 429 RETRY_WAITING (got ${regenRes2.status})`)
  assert(regenBody2.fromStage === 'dub.render', `Resumed directly from dub.render (got ${regenBody2.fromStage})`)

  // Wait for pipeline to complete
  for (let i = 0; i < 30; i++) {
    const pCheck = await queryOne('SELECT status FROM projects WHERE id = ?', [p2Id])
    if (pCheck.status === 'completed') break
    await new Promise((r) => setTimeout(r, 100))
  }
  const p2Final = await queryOne('SELECT status FROM projects WHERE id = ?', [p2Id])
  assert(p2Final.status === 'completed', 'Project p2 reached completed status')
  assert(renderRan, 'dub.render executed')

  // ── TEST 5: Edge Case — Incomplete earlier stage (AC-DUB04, Edge Case 3) ──
  console.log('\n--- TEST 5: Incomplete earlier stage preserves earliest runnable stage ---')
  const p3Id = uuidv4()
  await insert('projects', {
    id: p3Id,
    user_id: userId,
    mode: 'TRANSLATE_DUB',
    title: 'Midway Failed Project',
    status: 'failed',
    transcript_version: 1,
    source_video_key: 'uploads/p3_src.mp4',
    params: JSON.stringify({ enableDubbing: true }),
  })
  // Stages: ingest, stt, merge are success; translate is failed; mask not run
  for (const st of ['dub.ingest', 'dub.stt', 'dub.merge']) {
    await insert('generation_jobs', {
      id: uuidv4(),
      project_id: p3Id,
      type: st,
      status: 'success',
    })
  }
  await insert('generation_jobs', {
    id: uuidv4(),
    project_id: p3Id,
    type: 'dub.translate',
    status: 'failed',
    error_message: 'TRANSLATE_FAILED',
  })
  await insert('generation_jobs', {
    id: uuidv4(),
    project_id: p3Id,
    type: 'dub.ttsAlign',
    status: 'pending',
  })
  await insert('transcript_segments', {
    id: uuidv4(),
    project_id: p3Id,
    index_num: 0,
    start_sec: 0,
    end_sec: 1.5,
    text: 'Midway text',
    translation: 'Văn bản giữa chừng',
  })

  // Disable dubbing
  await fetch(`${base}/${p3Id}/dubbing`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ enableDubbing: false }),
  })

  let translateRan = false
  runner.setStageImplOverride('dub.translate', async () => {
    translateRan = true
    return {}
  })
  runner.setStageImplOverride('dub.mask', async () => ({}))

  const regenRes3 = await fetch(`${base}/${p3Id}/regenerate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  const regenBody3 = await regenRes3.json()
  assert(regenRes3.status === 200, 'POST /regenerate returns 200 for midway project')
  assert(regenBody3.fromStage === 'dub.translate', `Resumed from earliest incomplete stage dub.translate (got ${regenBody3.fromStage})`)

  // Wait for pipeline to finish
  for (let i = 0; i < 30; i++) {
    const pCheck = await queryOne('SELECT status FROM projects WHERE id = ?', [p3Id])
    if (pCheck.status === 'completed') break
    await new Promise((r) => setTimeout(r, 100))
  }
  const p3Final = await queryOne('SELECT status FROM projects WHERE id = ?', [p3Id])
  assert(p3Final.status === 'completed', 'Midway project finished as completed')
  assert(translateRan, 'dub.translate was executed')

  // ── TEST 6: Re-enable dubbing restores 7 stages (Edge Case 4) ─────────────
  console.log('\n--- TEST 6: Re-enabling dubbing restores dub.ttsAlign ---')
  const patchRes3 = await fetch(`${base}/${p3Id}/dubbing`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ enableDubbing: true, voiceProvider: 'edge_tts' }),
  })
  assert(patchRes3.status === 200, 'PATCH /dubbing with enableDubbing: true returns 200')
  const p3Restored = await queryOne('SELECT params FROM projects WHERE id = ?', [p3Id])
  const restoredStages = runner.stagesForProject({ mode: 'TRANSLATE_DUB', params: p3Restored.params })
  assert(restoredStages.length === 7 && restoredStages.includes('dub.ttsAlign'), '7 stages restored after re-enabling dubbing')

} catch (err) {
  console.error('Test error:', err)
  failures++
} finally {
  runner.clearStageImplOverrides()
  server.close()
  try { fs.rmSync(tmpDb, { force: true }) } catch (_) {}
  try { fs.rmSync(tmpStorage, { recursive: true, force: true }) } catch (_) {}
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertions failed.`)
  process.exit(1)
} else {
  console.log('\nALL PASS: dubRemoveAndResume suite passed completely!')
  process.exit(0)
}
