import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { once } from 'node:events'
import express from 'express'
import { v4 as uuidv4 } from 'uuid'

const tmpDb = path.join(os.tmpdir(), `vidai_queued_resume_${Date.now()}.db`)
const tmpStorage = path.join(os.tmpdir(), `vidai_queued_resume_storage_${Date.now()}`)
process.env.DB_PATH = tmpDb
process.env.STORAGE_DIR = tmpStorage
process.env.MAX_CONCURRENT_PROJECTS_PER_USER = '1'
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
  // Setup users
  const userId1 = uuidv4()
  const userId2 = uuidv4()
  await insert('users', {
    id: userId1,
    email: 'user1@test.local',
    password: 'hash',
    role: 'user',
    created_date: new Date().toISOString(),
  })
  await insert('users', {
    id: userId2,
    email: 'user2@test.local',
    password: 'hash',
    role: 'user',
    created_date: new Date().toISOString(),
  })
  const token1 = generateAccessToken({ id: userId1, role: 'user', email: 'user1@test.local' })
  const token2 = generateAccessToken({ id: userId2, role: 'user', email: 'user2@test.local' })

  // T1: Review gate
  console.log('\n--- T1: Review gate (script_review_required=1) ---')
  const p1Id = uuidv4()
  await insert('projects', {
    id: p1Id,
    user_id: userId1,
    mode: 'SCRIPT_TO_VIDEO',
    title: 'Script Queued',
    status: 'queued',
    script_review_required: 1,
    params: '{}',
  })
  const res1 = await fetch(`${base}/${p1Id}/regenerate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': 'application/json',
    },
  })
  const body1 = await res1.json()
  assert(res1.status === 409, `T1 returns 409 (got ${res1.status})`)
  assert(body1.code === 'SCRIPT_REVIEW_REQUIRED' || body1.error?.code === 'SCRIPT_REVIEW_REQUIRED', 'T1 code is SCRIPT_REVIEW_REQUIRED')
  const p1Db = await queryOne('SELECT status, script_review_required FROM projects WHERE id = ?', [p1Id])
  assert(p1Db.status === 'queued', 'T1 project status remains queued')
  assert(Number(p1Db.script_review_required) === 1, 'T1 script_review_required remains 1')

  // T2: All success
  console.log('\n--- T2: All jobs success ---')
  const p2Id = uuidv4()
  await insert('projects', {
    id: p2Id,
    user_id: userId1,
    mode: 'TRANSLATE_DUB',
    title: 'All Success Queued',
    status: 'queued',
    params: '{}',
  })
  const dubStages = ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.mask', 'dub.ttsAlign', 'dub.render']
  for (const st of dubStages) {
    await insert('generation_jobs', {
      id: uuidv4(),
      project_id: p2Id,
      type: st,
      status: 'success',
    })
  }
  const res2 = await fetch(`${base}/${p2Id}/regenerate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': 'application/json',
    },
  })
  const body2 = await res2.json()
  assert(res2.status === 409, `T2 returns 409 (got ${res2.status})`)
  assert(body2.code === 'ALREADY_COMPLETED' || body2.error?.code === 'ALREADY_COMPLETED', 'T2 code is ALREADY_COMPLETED')
  const jobs2 = await query('SELECT status FROM generation_jobs WHERE project_id = ?', [p2Id])
  assert(jobs2.every((j) => j.status === 'success'), 'T2 all jobs stay success')

  // T3: Retry cooldown
  console.log('\n--- T3: Retry cooldown (next_retry_at future) ---')
  const p3Id = uuidv4()
  await insert('projects', {
    id: p3Id,
    user_id: userId1,
    mode: 'TRANSLATE_DUB',
    title: 'Retry Waiting Queued',
    status: 'queued',
    params: '{}',
  })
  await insert('generation_jobs', {
    id: uuidv4(),
    project_id: p3Id,
    type: 'dub.ingest',
    status: 'success',
  })
  const futureRetry = new Date(Date.now() + 600000).toISOString()
  await insert('generation_jobs', {
    id: uuidv4(),
    project_id: p3Id,
    type: 'dub.stt',
    status: 'retry',
    next_retry_at: futureRetry,
  })
  const res3 = await fetch(`${base}/${p3Id}/regenerate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': 'application/json',
    },
  })
  const body3 = await res3.json()
  assert(res3.status === 429, `T3 returns 429 (got ${res3.status})`)
  assert(body3.code === 'RETRY_WAITING' || body3.error?.code === 'RETRY_WAITING', 'T3 code is RETRY_WAITING')
  assert(body3.stage === 'dub.stt' || body3.error?.stage === 'dub.stt' || body3.details?.stage === 'dub.stt', 'T3 stage is dub.stt')

  // T4: Concurrency full
  console.log('\n--- T4: Concurrency full ---')
  const pBusyId = uuidv4()
  await insert('projects', {
    id: pBusyId,
    user_id: userId1,
    mode: 'TRANSLATE_DUB',
    title: 'Active Project',
    status: 'running',
    run_token: 'busy_token',
    lease_expires_at: new Date(Date.now() + 60000).toISOString(),
    params: '{}',
  })
  const p4Id = uuidv4()
  await insert('projects', {
    id: p4Id,
    user_id: userId1,
    mode: 'TRANSLATE_DUB',
    title: 'Queued Waiting For Slot',
    status: 'queued',
    run_token: null,
    params: '{}',
  })
  const res4 = await fetch(`${base}/${p4Id}/regenerate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': 'application/json',
    },
  })
  const body4 = await res4.json()
  assert(res4.status === 429, `T4 returns 429 (got ${res4.status})`)
  assert(body4.code === 'LIMIT_001' || body4.error?.code === 'LIMIT_001', 'T4 code is LIMIT_001')
  const msg4 = body4.message || body4.error?.message || ''
  assert(/Đang chờ|giới hạn/i.test(msg4), `T4 message explains waiting for slot (got: "${msg4}")`)
  const p4Db = await queryOne('SELECT status, run_token FROM projects WHERE id = ?', [p4Id])
  assert(p4Db.status === 'queued', 'T4 target project stays queued')
  assert(p4Db.run_token === null, 'T4 target project run_token remains null')

  // T5 & T6: Resume runs the right stage & double start guard
  console.log('\n--- T5 & T6: Resume runs right stage and double-start ---')
  // Free up concurrency by marking busy project completed
  await run('UPDATE projects SET status = "completed", run_token = NULL WHERE id = ?', [pBusyId])

  const p5Id = uuidv4()
  await insert('projects', {
    id: p5Id,
    user_id: userId1,
    mode: 'TRANSLATE_DUB',
    title: 'Resume at render',
    status: 'queued',
    run_token: null,
    transcript_version: 1,
    params: '{}',
  })
  const completedStages = ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.mask', 'dub.ttsAlign']
  for (const st of completedStages) {
    await insert('generation_jobs', {
      id: uuidv4(),
      project_id: p5Id,
      type: st,
      status: 'success',
    })
  }
  await insert('transcript_segments', {
    id: uuidv4(),
    project_id: p5Id,
    index_num: 0,
    start_sec: 0,
    end_sec: 1,
    text: 'Hello world',
    translation: 'Xin chào',
  })

  let releaseRender
  const renderGate = new Promise((resolve) => { releaseRender = resolve })
  const started = []

  runner.setStageImplOverride('dub.render', async () => {
    started.push('dub.render')
    await renderGate
    return {}
  })
  runner.setStageImplOverride('dub.translate', async () => {
    throw new Error('must not run earlier stages')
  })

  const res5 = await fetch(`${base}/${p5Id}/regenerate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': 'application/json',
    },
  })
  const body5 = await res5.json()
  assert(res5.status === 200, `T5 returns 200 (got ${res5.status})`)
  assert(body5.fromStage === 'dub.render', `T5 fromStage is dub.render (got ${body5.fromStage})`)

  // Wait a moment for pipeline to enter stage override
  for (let i = 0; i < 20 && !started.length; i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  assert(started.includes('dub.render'), 'T5 started dub.render')

  // T6: Double-start while pipeline running
  const res6 = await fetch(`${base}/${p5Id}/regenerate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token1}`,
      'Content-Type': 'application/json',
    },
  })
  const body6 = await res6.json()
  assert(res6.status === 409, `T6 returns 409 while running (got ${res6.status})`)
  assert(body6.code === 'PIPELINE_RUNNING' || body6.code === 'PIPELINE_BUSY', `T6 code is PIPELINE_RUNNING or BUSY (got ${body6.code})`)

  // Release render
  releaseRender()
  // Wait for completion
  for (let i = 0; i < 30; i++) {
    const p5Db = await queryOne('SELECT status FROM projects WHERE id = ?', [p5Id])
    if (p5Db.status === 'completed') break
    await new Promise((r) => setTimeout(r, 100))
  }
  const p5Final = await queryOne('SELECT status FROM projects WHERE id = ?', [p5Id])
  assert(p5Final.status === 'completed', 'T5 project finished as completed')
  assert(started.length === 1, `T6 exactly one execution ran (got ${started.length})`)

  // T7: Ownership check
  console.log('\n--- T7: Ownership check ---')
  const res7 = await fetch(`${base}/${p5Id}/regenerate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token2}`, // user 2
      'Content-Type': 'application/json',
    },
  })
  const body7 = await res7.json()
  assert(res7.status === 403, `T7 returns 403 (got ${res7.status})`)
  assert(body7.code === 'AUTH_002' || body7.error?.code === 'AUTH_002', 'T7 code is AUTH_002')

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
  console.log('\nALL PASS: queuedResume suite passed completely!')
  process.exit(0)
}
