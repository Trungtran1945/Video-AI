import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { once } from 'node:events'
import express from 'express'
import { v4 as uuidv4 } from 'uuid'

const tmpDb = path.join(os.tmpdir(), `vidai_render_rerun_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)
const tmpStorage = path.join(os.tmpdir(), `vidai_render_rerun_storage_${Date.now()}_${Math.random().toString(36).slice(2)}`)
process.env.DB_PATH = tmpDb
process.env.STORAGE_DIR = tmpStorage
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const { insert, run, queryOne, query } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const projectsRouter = (await import('../src/routes/v1/projects.js')).default
const generationRouter = (await import('../src/routes/v1/generation.js')).default
const runner = await import('../src/pipeline/runner.js')
const { firstRunnableStage, projectDir } = await import('../src/pipeline/context.js')
const { validateForRender } = await import('../src/pipeline/stages/dubMerge.js')
const { hasHardTranslationError } = await import('../src/pipeline/stages/dubTranslate.js')
const { connection } = await import('../src/queue/connection.js')
const { notifyQueue } = await import('../src/queue/notifyQueue.js')

await initSchema()
try { connection.disconnect() } catch (_) {}
try { notifyQueue.close() } catch (_) {}

fs.mkdirSync(path.join(tmpStorage, 'uploads'), { recursive: true })
fs.writeFileSync(path.join(tmpStorage, 'uploads', 'src_video.mp4'), 'dummy source video')

const app = express()
app.use(express.json())
app.use('/api/v1/projects', projectsRouter)
app.use('/api/v1/projects', generationRouter)
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
    email: 'user_render@test.local',
    password: 'hash',
    role: 'user',
    created_date: new Date().toISOString(),
  })
  const token = generateAccessToken({ id: userId, role: 'user', email: 'user_render@test.local' })

  // ── TEST 1: firstRunnableStage with normalizeJobStatus (AC-REN01) ──────────
  console.log('\n--- TEST 1: firstRunnableStage handles completed and success ---')
  const order = ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.mask', 'dub.ttsAlign', 'dub.render']
  const completedJobs = order.map((t) => ({ type: t, status: t === 'dub.render' ? 'pending' : 'completed' }))
  const r1 = firstRunnableStage(order, completedJobs)
  assert(r1.type === 'dub.render', `firstRunnableStage treats 'completed' as finished, picks dub.render (got: ${r1.type})`)

  // ── TEST 2: validateForRender ignores TTS when audioMode === 'ORIGINAL_ONLY' (AC-REN02) ─
  console.log('\n--- TEST 2: validateForRender with ORIGINAL_ONLY ---')
  const pOrigId = uuidv4()
  await insert('projects', {
    id: pOrigId,
    user_id: userId,
    mode: 'TRANSLATE_DUB',
    title: 'Original Audio Only Project',
    status: 'failed',
    transcript_version: 1,
    source_video_key: 'uploads/src_video.mp4',
    params: JSON.stringify({ enableDubbing: false, audioMode: 'ORIGINAL_ONLY' }),
  })
  await insert('transcript_segments', {
    id: uuidv4(),
    project_id: pOrigId,
    index_num: 0,
    start_sec: 0,
    end_sec: 2.0,
    text: 'Hello original',
    translation: 'Xin chào âm thanh gốc',
    tts_audio_id: null, // NO TTS Audio
  })
  const vOrig = await validateForRender(pOrigId)
  assert(vOrig.valid === true, 'validateForRender is valid without TTS audio in ORIGINAL_ONLY')
  const hasMissingTts = (vOrig.errors || []).some((e) => e.code === 'MISSING_TTS_AUDIO')
  assert(!hasMissingTts, 'validateForRender has no MISSING_TTS_AUDIO error')

  // ── TEST 2B: Manual edit exemption & CJK numeral mismatch (AC-REN01, AC-REN02) ─
  console.log('\n--- TEST 2B: Manual edit exemption & CJK numeral mismatch ---')
  const pManualId = uuidv4()
  await insert('projects', {
    id: pManualId,
    user_id: userId,
    mode: 'TRANSLATE_DUB',
    title: 'Manual Edit & CJK Numeral Project',
    status: 'failed',
    transcript_version: 1,
    source_video_key: 'uploads/src_video.mp4',
    params: JSON.stringify({ enableDubbing: false, audioMode: 'ORIGINAL_ONLY' }),
  })
  // Segment #2: CJK with 万 (50万 -> 500 nghìn), manually edited
  await insert('transcript_segments', {
    id: uuidv4(),
    project_id: pManualId,
    index_num: 2,
    start_sec: 2.0,
    end_sec: 4.0,
    text: '可拿到整整50万的现金后',
    translation: 'Nhưng sau khi nhận đủ 500 nghìn tiền mặt',
    is_translation_manually_edited: 1,
  })
  // Segment #245: CJK with 一 (一型 -> loại 1), manually edited
  await insert('transcript_segments', {
    id: uuidv4(),
    project_id: pManualId,
    index_num: 245,
    start_sec: 4.0,
    end_sec: 6.0,
    text: '一个真正的一型糖尿病患者',
    translation: 'người mắc bệnh tiểu đường loại 1',
    is_translation_manually_edited: 1,
  })
  const vManual = await validateForRender(pManualId)
  assert(vManual.valid === true, `validateForRender passes with manually edited CJK segments (errors: ${JSON.stringify(vManual.errors)})`)
  const hasSemanticBlock = (vManual.errors || []).some((e) => e.code === 'SEMANTIC_BLOCK')
  assert(!hasSemanticBlock, 'validateForRender does NOT throw SEMANTIC_BLOCK for manually edited segments')
  const hasWarning = (vManual.warnings || []).some((w) => w.code === 'SEMANTIC_WARNING')
  assert(hasWarning, 'Warnings capture soft notices without blocking render')

  // Direct test of hasHardTranslationError for CJK numeral words
  const cjkHard1 = hasHardTranslationError('可拿到整整50万的现金后', 'Nhưng sau khi nhận đủ 500 nghìn tiền mặt', 'vi')
  assert(cjkHard1.hard === false, 'hasHardTranslationError returns hard=false for 50万 -> 500 nghìn')
  const cjkHard2 = hasHardTranslationError('一个真正的一型糖尿病患者', 'người mắc bệnh tiểu đường loại 1', 'vi')
  assert(cjkHard2.hard === false, 'hasHardTranslationError returns hard=false for 一型 -> loại 1')

  // ── TEST 3: clearArtifacts removes temporary render files (AC-REN05) ──────
  console.log('\n--- TEST 3: clearArtifacts cleans temporary render files ---')
  const pClearId = uuidv4()
  await insert('projects', {
    id: pClearId,
    user_id: userId,
    mode: 'TRANSLATE_DUB',
    title: 'Clear Artifacts Project',
    status: 'pending',
    transcript_version: 1,
    source_video_key: 'uploads/src_video.mp4',
    params: JSON.stringify({ enableDubbing: false, audioMode: 'ORIGINAL_ONLY' }),
  })
  const pClearDir = projectDir(pClearId)
  fs.mkdirSync(pClearDir, { recursive: true })
  fs.writeFileSync(path.join(pClearDir, 'masked.mp4'), 'temp masked')
  fs.writeFileSync(path.join(pClearDir, 'burned.mp4'), 'temp burned')
  fs.writeFileSync(path.join(pClearDir, 'final.mp4'), 'temp final')
  fs.writeFileSync(path.join(pClearDir, 'dub_track.wav'), 'temp wav')
  fs.writeFileSync(path.join(pClearDir, 'thumb.jpg'), 'temp thumb')

  let renderRan3 = false
  runner.setStageImplOverride('dub.render', async () => {
    renderRan3 = true
    return { outputKey: 'outputs/new_final.mp4' }
  })
  // Run pipeline from dub.render which triggers executeStage -> clearArtifacts
  for (const st of ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.mask', 'dub.ttsAlign']) {
    await insert('generation_jobs', { id: uuidv4(), project_id: pClearId, type: st, status: 'success' })
  }
  await insert('generation_jobs', { id: uuidv4(), project_id: pClearId, type: 'dub.render', status: 'pending' })
  await insert('transcript_segments', {
    id: uuidv4(),
    project_id: pClearId,
    index_num: 0,
    start_sec: 0,
    end_sec: 2.0,
    text: 'Clear test',
    translation: 'Bản dịch xóa rác',
  })

  // Start run
  await runner.runPipeline(pClearId, 'dub.render')
  assert(renderRan3, 'dub.render executed')
  // Check that old temporary files were unlinked
  const maskedExists = fs.existsSync(path.join(pClearDir, 'masked.mp4'))
  const burnedExists = fs.existsSync(path.join(pClearDir, 'burned.mp4'))
  const dubTrackExists = fs.existsSync(path.join(pClearDir, 'dub_track.wav'))
  assert(!maskedExists, 'masked.mp4 was unlinked')
  assert(!burnedExists, 'burned.mp4 was unlinked')
  assert(!dubTrackExists, 'dub_track.wav was unlinked')

  // ── TEST 4: POST /regenerate with fromStage = 'dub.render' on completed project (AC-REN01) ──
  console.log('\n--- TEST 4: POST /regenerate fromStage=dub.render on completed project ---')
  const p4Id = uuidv4()
  await insert('projects', {
    id: p4Id,
    user_id: userId,
    mode: 'TRANSLATE_DUB',
    title: 'Completed Project Rerun',
    status: 'completed',
    transcript_version: 1,
    source_video_key: 'uploads/src_video.mp4',
    params: JSON.stringify({ enableDubbing: false, audioMode: 'ORIGINAL_ONLY' }),
  })
  for (const st of ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.mask', 'dub.ttsAlign', 'dub.render']) {
    await insert('generation_jobs', { id: uuidv4(), project_id: p4Id, type: st, status: 'success' })
  }
  await insert('transcript_segments', {
    id: uuidv4(),
    project_id: p4Id,
    index_num: 0,
    start_sec: 0,
    end_sec: 2.0,
    text: 'Completed test',
    translation: 'Bản dịch chạy lại',
  })

  let renderRan4 = false
  runner.setStageImplOverride('dub.render', async () => {
    renderRan4 = true
    return {}
  })

  const regenRes4 = await fetch(`${base}/${p4Id}/regenerate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fromStage: 'dub.render' }),
  })
  const regenBody4 = await regenRes4.json()
  assert(regenRes4.status === 200, `POST /regenerate returns 200 on completed project (got: ${regenRes4.status})`)
  assert(regenBody4.fromStage === 'dub.render', `fromStage is dub.render (got: ${regenBody4.fromStage})`)

  // Wait for pipeline to complete
  for (let i = 0; i < 30; i++) {
    const pCheck = await queryOne('SELECT status FROM projects WHERE id = ?', [p4Id])
    if (pCheck.status === 'completed') break
    await new Promise((r) => setTimeout(r, 100))
  }
  const p4Final = await queryOne('SELECT status FROM projects WHERE id = ?', [p4Id])
  assert(p4Final.status === 'completed', 'Project reached completed status')
  assert(renderRan4, 'dub.render was executed')

  // ── TEST 5: POST /jobs/:type/retry allows retry on stalled 'running' job (AC-REN04) ──────
  console.log('\n--- TEST 5: POST /jobs/:type/retry on stalled running job ---')
  const p5Id = uuidv4()
  await insert('projects', {
    id: p5Id,
    user_id: userId,
    mode: 'TRANSLATE_DUB',
    title: 'Stalled Running Job Project',
    status: 'failed',
    transcript_version: 1,
    source_video_key: 'uploads/src_video.mp4',
    params: JSON.stringify({ enableDubbing: false, audioMode: 'ORIGINAL_ONLY' }),
  })
  for (const st of ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.mask', 'dub.ttsAlign']) {
    await insert('generation_jobs', { id: uuidv4(), project_id: p5Id, type: st, status: 'success' })
  }
  // Stalled job in running state
  const renderJobId5 = uuidv4()
  await insert('generation_jobs', {
    id: renderJobId5,
    project_id: p5Id,
    type: 'dub.render',
    status: 'running',
    step: 'muxing',
    progress: 80,
  })
  await insert('transcript_segments', {
    id: uuidv4(),
    project_id: p5Id,
    index_num: 0,
    start_sec: 0,
    end_sec: 2.0,
    text: 'Stalled test',
    translation: 'Bản dịch retry stalled',
  })

  let renderRan5 = false
  runner.setStageImplOverride('dub.render', async () => {
    renderRan5 = true
    return {}
  })

  const retryRes5 = await fetch(`${base}/${p5Id}/jobs/dub.render/retry`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  const retryBody5 = await retryRes5.json()
  assert(retryRes5.status === 200, `Retry on stalled running job returns 200 (got: ${retryRes5.status})`)
  assert(retryBody5.fromStage === 'dub.render', `Retrying from dub.render (got: ${retryBody5.fromStage})`)

  for (let i = 0; i < 30; i++) {
    const pCheck = await queryOne('SELECT status FROM projects WHERE id = ?', [p5Id])
    if (pCheck.status === 'completed') break
    await new Promise((r) => setTimeout(r, 100))
  }
  assert(renderRan5, 'dub.render was executed after retrying stalled job')

  // ── TEST 6: Auto-sanitize synchronizes snapshot to dub.ttsAlign (AC-REN03) ──
  console.log('\n--- TEST 6: Provenance synchronization on auto-sanitize ---')
  const p6Id = uuidv4()
  await insert('projects', {
    id: p6Id,
    user_id: userId,
    mode: 'TRANSLATE_DUB',
    title: 'Provenance Sync Project',
    status: 'failed',
    transcript_version: 1,
    source_video_key: 'uploads/src_video.mp4',
    params: JSON.stringify({ enableDubbing: true }),
  })
  for (const st of ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.mask']) {
    await insert('generation_jobs', { id: uuidv4(), project_id: p6Id, type: st, status: 'success' })
  }
  // dub.ttsAlign has frozen snapshot at version 1
  const ttsJobId = uuidv4()
  await insert('generation_jobs', {
    id: ttsJobId,
    project_id: p6Id,
    type: 'dub.ttsAlign',
    status: 'success',
    result: JSON.stringify({ transcriptVersionSnapshot: 1 }),
  })
  await insert('generation_jobs', {
    id: uuidv4(),
    project_id: p6Id,
    type: 'dub.render',
    status: 'pending',
  })
  const audio1Id = uuidv4()
  const audio2Id = uuidv4()
  await insert('audios', { id: audio1Id, project_id: p6Id, kind: 'voice', duration_sec: 1.0, provider: 'edge_tts' })
  await insert('audios', { id: audio2Id, project_id: p6Id, kind: 'voice', duration_sec: 1.0, provider: 'edge_tts' })

  // Segments with slight overlap to trigger auto-sanitize
  await insert('transcript_segments', {
    id: uuidv4(),
    project_id: p6Id,
    index_num: 0,
    start_sec: 0,
    end_sec: 1.05,
    text: 'Segment one',
    translation: 'Câu một',
    tts_audio_id: audio1Id,
  })
  await insert('transcript_segments', {
    id: uuidv4(),
    project_id: p6Id,
    index_num: 1,
    start_sec: 1.0,
    end_sec: 2.0,
    text: 'Segment two',
    translation: 'Câu hai',
    tts_audio_id: audio2Id,
  })

  runner.setStageImplOverride('dub.render', async (ctx) => {
    // Assert that the ctx snapshot was updated to the new revision (>1)
    assert(ctx.transcriptVersionSnapshot > 1, `ctx.transcriptVersionSnapshot updated (got: ${ctx.transcriptVersionSnapshot})`)
    return {}
  })

  await runner.runPipeline(p6Id, 'dub.render')

  // Verify that dub.ttsAlign's job result was synchronized
  const updatedTtsJob = await queryOne('SELECT result FROM generation_jobs WHERE id = ?', [ttsJobId])
  const parsedRes = JSON.parse(updatedTtsJob.result)
  assert(parsedRes.transcriptVersionSnapshot > 1, `dub.ttsAlign transcriptVersionSnapshot synchronized to ${parsedRes.transcriptVersionSnapshot}`)

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
  console.log('\nALL PASS: dubRenderRerun suite passed completely!')
  process.exit(0)
}
