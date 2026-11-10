import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import express from 'express'
import { once } from 'node:events'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-prog-dub-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')

const { initSchema } = await import('../src/db/schema.js')
const { queryOne, insert, run } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const projectsRouter = (await import('../src/routes/v1/projects.js')).default

await initSchema()

const user = { id: 'prog-test-user', email: 'prog@test.local', role: 'user', password: 'test' }
await insert('users', user)
const token = generateAccessToken(user)

let failures = 0
function assert(condition, message) {
  if (condition) console.log('PASS:', message)
  else { failures += 1; console.error('FAIL:', message) }
}

async function makeProject(id, status, params) {
  await insert('projects', {
    id,
    user_id: user.id,
    mode: 'TRANSLATE_DUB',
    title: 'Progress and Dubbing Test',
    status,
    language: 'vi',
    target_duration_sec: 60,
    params: JSON.stringify(params),
    transcript_version: 1,
  })
}

const app = express()
app.use(express.json())
app.use('/api/v1/projects', projectsRouter)
const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/api/v1/projects`

async function patchDubbing(id, body) {
  const res = await fetch(`${baseUrl}/${id}/dubbing`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch (_) {}
  return { status: res.status, body: json }
}

console.log('=== TEST SUITE: Progress & Dubbing State Management ===')

// 1. Cho phép đổi/xoá lồng tiếng khi project ở trạng thái 'completed' (AC-L04)
const pCompleted = 'proj-state-completed'
await makeProject(pCompleted, 'completed', { enableDubbing: true, voiceProvider: 'edge_tts', audioMode: 'DUB_MIX' })
const res1 = await patchDubbing(pCompleted, { enableDubbing: false })
assert(res1.status === 200, 'AC-L04: PATCH dubbing thành công khi pipeline completed')
assert(res1.body?.params?.enableDubbing === false, 'AC-L04: enableDubbing đã được chuyển sang false')
assert(res1.body?.params?.audioMode === 'ORIGINAL_ONLY', 'AC-L04: audioMode tự động chuyển về ORIGINAL_ONLY')

// 2. Cho phép đổi provider khi project ở trạng thái 'failed' (AC-L04)
const pFailed = 'proj-state-failed'
await makeProject(pFailed, 'failed', { enableDubbing: true, voiceProvider: 'edge_tts', audioMode: 'DUB_MIX' })
const res2 = await patchDubbing(pFailed, { enableDubbing: true, voiceProvider: 'elevenlabs', voiceId: 'voice-123' })
assert(res2.status === 200, 'AC-L04: PATCH dubbing thành công khi pipeline failed')
assert(res2.body?.params?.voiceProvider === 'elevenlabs', 'AC-L04: Đổi sang elevenlabs thành công')
assert(res2.body?.params?.voiceId === 'voice-123', 'AC-L04: Cập nhật voiceId thành công')

// 3. Cho phép chỉnh sửa khi project ở trạng thái 'queued' (AC-L04)
const pQueued = 'proj-state-queued'
await makeProject(pQueued, 'queued', { enableDubbing: false, audioMode: 'ORIGINAL_ONLY' })
const res3 = await patchDubbing(pQueued, { enableDubbing: true, voiceProvider: 'voicestudio' })
assert(res3.status === 200, 'AC-L04: PATCH dubbing thành công khi pipeline queued (chưa có worker chạy)')
assert(res3.body?.params?.enableDubbing === true, 'AC-L04: Bật lại lồng tiếng thành công')
assert(res3.body?.params?.audioMode === 'DUB_MIX', 'AC-L04: audioMode chuyển về DUB_MIX khi enable')

// 4. Cho phép chỉnh sửa khi project ở trạng thái 'cancelled'
const pCancelled = 'proj-state-cancelled'
await makeProject(pCancelled, 'cancelled', { enableDubbing: true, voiceProvider: 'edge_tts', audioMode: 'DUB_MIX' })
const res4 = await patchDubbing(pCancelled, { enableDubbing: false })
assert(res4.status === 200, 'AC-L04: PATCH dubbing thành công khi pipeline cancelled')
assert(res4.body?.params?.enableDubbing === false, 'AC-L04: Huỷ lồng tiếng sau khi cancel thành công')

// 5. Kiểm tra logic tính toán tiến trình (computedProgress)
function computeProgress(stages, jobByStage, effectiveStatus, activeRunningStage, projectProgress = 0) {
  if (effectiveStatus === 'completed') return 100
  if (!stages || !stages.length) return projectProgress || 0
  const completedCount = stages.filter((s) => {
    const status = jobByStage[s]?.status
    return status === 'success' || status === 'completed' || status === 'skipped'
  }).length
  const runningJob = activeRunningStage ? jobByStage[activeRunningStage] : null
  const currentStageFraction = runningJob?.progress ? Math.min(99, Math.max(0, runningJob.progress)) / 100 : 0
  const calculated = Math.round(((completedCount + currentStageFraction) / stages.length) * 100)
  return Math.min(99, Math.max(projectProgress || 0, calculated))
}

const dubStages = ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.mask', 'dub.ttsAlign', 'dub.render']

// Khi vừa tạo (chưa stage nào xong): progress = 0%
const prog0 = computeProgress(dubStages, {}, 'queued', null, 0)
assert(prog0 === 0, 'AC-L03: Chưa có stage nào hoàn thành -> tiến trình 0%')

// Khi xong 3/7 stage (dub.ingest, dub.stt, dub.merge): ~43%
const jobs3 = {
  'dub.ingest': { status: 'success' },
  'dub.stt': { status: 'success' },
  'dub.merge': { status: 'success' },
}
const prog3 = computeProgress(dubStages, jobs3, 'running', null, 0)
assert(prog3 === 43, `AC-L03: Xong 3/7 stage -> tiến trình ~43% (got ${prog3}%)`)

// Khi xong 3/7 stage và stage 4 (dub.translate) đang chạy được 50%
const jobs3andHalf = {
  ...jobs3,
  'dub.translate': { status: 'running', progress: 50 },
}
const prog3Half = computeProgress(dubStages, jobs3andHalf, 'running', 'dub.translate', 0)
assert(prog3Half === 50, `AC-L03: Xong 3/7 stage + 50% stage 4 -> tiến trình 50% (got ${prog3Half}%)`)

// Khi tất cả các stage xong hoặc effectiveStatus = completed: 100%
const progDone = computeProgress(dubStages, jobs3, 'completed', null, 0)
assert(progDone === 100, 'AC-L03: effectiveStatus completed -> tiến trình 100%')

await new Promise((resolve) => server.close(resolve))
for (const id of [pCompleted, pFailed, pQueued, pCancelled]) {
  await run('DELETE FROM projects WHERE id = ?', [id])
}
await run('DELETE FROM users WHERE id = ?', [user.id])
fs.rmSync(process.env.DB_PATH, { force: true })

try {
  const { notifyQueue } = await import('../src/queue/notifyQueue.js')
  await notifyQueue.close().catch(() => {})
} catch (_) {}
try {
  const { connection } = await import('../src/queue/connection.js')
  connection.removeAllListeners('error')
  connection.disconnect()
} catch (_) {}
for (let i = 0; i < 100; i++) {
  const pending = process._getActiveHandles().filter((h) => h?.constructor?.name === 'Socket')
  if (pending.length === 0) break
  await new Promise((r) => setTimeout(r, 20))
}
await new Promise((r) => setTimeout(r, 100))

if (failures > 0) process.exit(1)
console.log('ALL PROGRESS & DUBBING STATE TESTS PASS')
process.exit(0)
