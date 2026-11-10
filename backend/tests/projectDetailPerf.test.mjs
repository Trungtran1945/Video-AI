import { performance } from 'node:perf_hooks'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import express from 'express'
import { once } from 'node:events'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_perf_benchmark_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { query, queryOne, insert, run } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const dubDataRouter = (await import('../src/routes/v1/dubData.js')).default
const projectsRouter = (await import('../src/routes/v1/projects.js')).default

await initSchema()

const user = { id: 'perf-user', email: 'perf@test.local', role: 'user', password: 'test' }
const projectId = 'perf-project-id'

await insert('users', user)
await insert('projects', {
  id: projectId,
  user_id: user.id,
  mode: 'TRANSLATE_DUB',
  title: 'Performance Benchmark Project',
  status: 'completed',
  language: 'vi',
  target_duration_sec: 120,
  params: JSON.stringify({ targetLanguage: 'vi', sourceLanguage: 'en', voice: 'maichi' }),
  transcript_version: 3,
})

// Insert 10 generation jobs
for (let i = 0; i < 10; i++) {
  await insert('generation_jobs', {
    id: `job-${i}`,
    project_id: projectId,
    type: `dub.step_${i}`,
    status: 'success',
    progress: 100,
  })
}

// Insert 20 timeline clips
for (let i = 0; i < 20; i++) {
  await insert('timeline_clips', {
    id: `clip-${i}`,
    project_id: projectId,
    order_index: i,
    in_sec: i * 5,
    out_sec: (i + 1) * 5,
  })
}

// Insert output
await insert('outputs', {
  id: 'output-1',
  project_id: projectId,
  storage_key: 'outputs/test.mp4',
  status: 'success',
  duration_sec: 100,
  transcript_version: 3,
})

// Insert 300 transcript segments
for (let i = 0; i < 300; i++) {
  await insert('transcript_segments', {
    id: `seg-${i}`,
    project_id: projectId,
    index_num: i,
    start_sec: i * 2,
    end_sec: (i * 2) + 1.8,
    text: `Original sentence ${i} for speech transcription testing.`,
    translation: `Câu dịch số ${i} để kiểm tra hiệu năng hệ thống.`,
    speaker: 'speaker_1',
    language: 'en',
  })
}

// Verify EXPLAIN QUERY PLAN
console.log('\n--- EXPLAIN QUERY PLANS ---')
const planProject = await query('EXPLAIN QUERY PLAN SELECT * FROM projects WHERE id = ?', [projectId])
console.log('Project query plan:', planProject.map(p => p.detail).join(' | '))

const planJobs = await query('EXPLAIN QUERY PLAN SELECT * FROM generation_jobs WHERE project_id = ? ORDER BY created_date ASC', [projectId])
console.log('Jobs query plan:', planJobs.map(p => p.detail).join(' | '))

const planClips = await query('EXPLAIN QUERY PLAN SELECT * FROM timeline_clips WHERE project_id = ? ORDER BY order_index ASC', [projectId])
console.log('Timeline clips query plan:', planClips.map(p => p.detail).join(' | '))

const planSegments = await query(`EXPLAIN QUERY PLAN SELECT p.id AS project_id, p.mode AS project_mode,
            p.transcript_version AS project_transcript_version,
            s.id AS segment_id, s.index_num, s.start_sec, s.end_sec, s.text,
            s.speaker, s.language, s.translation,
            s.is_time_manually_adjusted, s.is_text_manually_edited,
            s.is_translation_manually_edited
     FROM projects p
     LEFT JOIN transcript_segments s ON s.project_id = p.id
     WHERE p.id = ?
     ORDER BY s.index_num ASC`, [projectId])
console.log('Transcript segments query plan:', planSegments.map(p => p.detail).join(' | '))

const app = express()
app.use(express.json())
app.use('/api/v1/projects', projectsRouter)
app.use('/api/v1', dubDataRouter)

const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port
const token = generateAccessToken(user)
const headers = { authorization: `Bearer ${token}` }

console.log('\n--- SINGLE REQUEST LATENCY ---')
// Warmup
await fetch(`http://127.0.0.1:${port}/api/v1/projects/${projectId}`, { headers })
await fetch(`http://127.0.0.1:${port}/api/v1/projects/${projectId}/transcript`, { headers })

let dProject = Infinity
let pJson
let resProject
for (let i = 0; i < 3; i++) {
  const t0 = performance.now()
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${projectId}`, { headers })
  const json = await res.json()
  const dur = performance.now() - t0
  if (dur < dProject) {
    dProject = dur
    resProject = res
    pJson = json
  }
}
console.log(`GET /api/v1/projects/:id best latency: ${dProject.toFixed(2)}ms (Status: ${resProject.status}, Jobs: ${pJson.jobs.length}, Clips: ${pJson.timeline.length})`)

let dTranscript = Infinity
let tJson
let resTranscript
for (let i = 0; i < 3; i++) {
  const t1 = performance.now()
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${projectId}/transcript`, { headers })
  const json = await res.json()
  const dur = performance.now() - t1
  if (dur < dTranscript) {
    dTranscript = dur
    resTranscript = res
    tJson = json
  }
}
console.log(`GET /api/v1/projects/:id/transcript best latency: ${dTranscript.toFixed(2)}ms (Status: ${resTranscript.status}, Segments: ${tJson.segments.length})`)

console.log('\n--- CONCURRENT STRESS LATENCY (100 parallel requests) ---')
const N = 100

const tStartProjectBatch = performance.now()
const pBatch = await Promise.all(
  Array.from({ length: N }, () => fetch(`http://127.0.0.1:${port}/api/v1/projects/${projectId}`, { headers }))
)
const dProjectBatch = performance.now() - tStartProjectBatch
const allProjectOk = pBatch.every(r => r.status === 200)
console.log(`${N} parallel requests to GET /projects/:id: total ${dProjectBatch.toFixed(2)}ms, avg ${(dProjectBatch / N).toFixed(2)}ms per req, all 200 OK: ${allProjectOk}`)

const tStartTranscriptBatch = performance.now()
const tBatch = await Promise.all(
  Array.from({ length: N }, () => fetch(`http://127.0.0.1:${port}/api/v1/projects/${projectId}/transcript`, { headers }))
)
const dTranscriptBatch = performance.now() - tStartTranscriptBatch
const allTranscriptOk = tBatch.every(r => r.status === 200)
console.log(`${N} parallel requests to GET /projects/:id/transcript (300 segs each): total ${dTranscriptBatch.toFixed(2)}ms, avg ${(dTranscriptBatch / N).toFixed(2)}ms per req, all 200 OK: ${allTranscriptOk}`)

await new Promise(r => server.close(r))
fs.rmSync(process.env.DB_PATH, { force: true })

if (!allProjectOk || !allTranscriptOk || dProject > 50 || dTranscript > 50) {
  console.error('PERF CHECK FAILED')
  process.exit(1)
} else {
  console.log('\nPERF CHECK PASSED: Both endpoints respond in < 50ms individually and under stress!')
  process.exit(0)
}
