import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import express from 'express'
import { once } from 'node:events'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_script_audio_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const { projectDir, ensureDir, toStorageKey } = await import('../src/pipeline/context.js')
const router = (await import('../src/routes/v1/projects.js')).default

await initSchema()

console.log('=== SCRIPT_TO_VIDEO Segment Audio Serving Tests ===\n')

const user1 = { id: 'audio-user-1', email: 'owner@test.local', role: 'user', password: 'pwd' }
const user2 = { id: 'audio-user-2', email: 'other@test.local', role: 'user', password: 'pwd' }
await insert('users', user1)
await insert('users', user2)

const token1 = generateAccessToken(user1)
const token2 = generateAccessToken(user2)

const projectId = 'proj-script-audio-test'
await insert('projects', {
  id: projectId,
  user_id: user1.id,
  mode: 'SCRIPT_TO_VIDEO',
  title: 'Script Audio Serving Project',
  status: 'running',
  script_version: 1,
  aspect_ratio: '16:9',
})

// Create test audio file on disk
const pDir = ensureDir(projectDir(projectId))
const audioDir = ensureDir(path.join(pDir, 'segments', '0_seg1'))
const audioFilePath = path.join(audioDir, 'clip_test.mp3')
const mockAudioContent = Buffer.from('FAKE_MP3_AUDIO_STREAM_CONTENT_1234567890')
fs.writeFileSync(audioFilePath, mockAudioContent)

const audioStorageKey = toStorageKey(audioFilePath)
const audioId = 'audio-row-1'
await insert('audios', {
  id: audioId,
  project_id: projectId,
  storage_key: audioStorageKey,
  duration_sec: 3.5,
})

const segWithAudioId = 'seg-with-audio'
await insert('script_segments', {
  id: segWithAudioId,
  project_id: projectId,
  index_num: 0,
  narration: 'Xin chào các bạn đến với video AI',
  visual_prompt: 'Hình ảnh logo giới thiệu',
  voice_audio_id: audioId,
  duration_sec: 3.5,
  status: 'tts_ready',
  content_hash: 'hash123',
})

const segWithoutAudioId = 'seg-without-audio'
await insert('script_segments', {
  id: segWithoutAudioId,
  project_id: projectId,
  index_num: 1,
  narration: 'Đoạn này chưa có âm thanh',
  visual_prompt: 'Slide 2',
  status: 'pending',
})

// Setup express test server
const app = express()
app.use(express.json())
app.use('/api/v1/projects', router)
const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port
const base = `http://127.0.0.1:${port}/api/v1/projects`

try {
  // 1. GET /projects/:id extras includes audioUrl
  {
    console.log('--- 1. Verification of audioUrl in project extras ---')
    const res = await fetch(`${base}/${projectId}`, {
      headers: { authorization: `Bearer ${token1}` },
    })
    assert.equal(res.status, 200, 'GET /projects/:id returns 200')
    const data = await res.json()
    const segments = data.scriptSegments || []
    assert.equal(segments.length, 2, 'Has 2 segments')
    
    const s1 = segments.find((s) => s.id === segWithAudioId)
    assert(s1, 'Found seg1')
    assert(s1.hasAudio === true, 'seg1 hasAudio is true')
    assert(s1.audioUrl.includes(`/api/v1/projects/${projectId}/script/segments/${segWithAudioId}/audio`), 'seg1 has correct audioUrl')

    const s2 = segments.find((s) => s.id === segWithoutAudioId)
    assert(s2, 'Found seg2')
    assert(s2.hasAudio === false, 'seg2 hasAudio is false')
    assert.equal(s2.audioUrl, null, 'seg2 audioUrl is null')
    console.log('PASS: audioUrl extras correctly generated')
  }

  // 2. GET /projects/:id/script/segments/:segmentId/audio - 200 OK & MIME
  {
    console.log('--- 2. Stream audio for owner (200 OK) ---')
    const res = await fetch(`${base}/${projectId}/script/segments/${segWithAudioId}/audio`, {
      headers: { authorization: `Bearer ${token1}` },
    })
    assert.equal(res.status, 200, 'Returns HTTP 200')
    assert.equal(res.headers.get('content-type'), 'audio/mpeg', 'MIME type is audio/mpeg')
    const buf = Buffer.from(await res.arrayBuffer())
    assert.equal(buf.toString(), mockAudioContent.toString(), 'Audio stream bytes match file on disk')
    console.log('PASS: 200 OK audio stream valid')
  }

  // 3. User isolation: 403 Forbidden for non-owner
  {
    console.log('--- 3. User isolation (403 Forbidden) ---')
    const res = await fetch(`${base}/${projectId}/script/segments/${segWithAudioId}/audio`, {
      headers: { authorization: `Bearer ${token2}` },
    })
    assert.equal(res.status, 403, 'Returns HTTP 403 for other user')
    const body = await res.json()
    assert.equal(body.code || body.error?.code, 'AUTH_002', 'Error code is AUTH_FORBIDDEN / AUTH_002')
    console.log('PASS: 403 Forbidden verified')
  }

  // 4. Segment without audio: 404
  {
    console.log('--- 4. Segment without audio (404 Not Found) ---')
    const res = await fetch(`${base}/${projectId}/script/segments/${segWithoutAudioId}/audio`, {
      headers: { authorization: `Bearer ${token1}` },
    })
    assert.equal(res.status, 404, 'Returns HTTP 404 when segment has no voice_audio_id')
    console.log('PASS: 404 for segment without audio verified')
  }

  // 5. Non-existent segment: 404
  {
    console.log('--- 5. Non-existent segment (404 Not Found) ---')
    const res = await fetch(`${base}/${projectId}/script/segments/non-existent-seg/audio`, {
      headers: { authorization: `Bearer ${token1}` },
    })
    assert.equal(res.status, 404, 'Returns HTTP 404 for missing segment')
    console.log('PASS: 404 for missing segment verified')
  }

  // 6. Path traversal attempt: 404
  {
    console.log('--- 6. Path traversal rejection ---')
    const res = await fetch(`${base}/${projectId}/script/segments/..%2F..%2Fetc/audio`, {
      headers: { authorization: `Bearer ${token1}` },
    })
    assert.equal(res.status, 404, 'Traversal segmentId returns 404')
    console.log('PASS: Path traversal rejection verified')
  }

  console.log('\nALL SCRIPT SEGMENT AUDIO TESTS PASSED!\n')
} finally {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve)).catch(() => {})
  try {
    const { connection } = await import('../src/queue/connection.js')
    try { connection.disconnect() } catch (_) {}
    const { projectQueue } = await import('../src/queue/projectQueue.js')
    const { drainQueue } = await import('../src/queue/drainQueue.js')
    const { notifyQueue } = await import('../src/queue/notifyQueue.js')
    const { cleanupQueue } = await import('../src/queue/cleanupQueue.js')
    await Promise.all([projectQueue.close(), drainQueue.close(), notifyQueue.close(), cleanupQueue.close()].map((p) => p.catch(() => {})))
  } catch (_) {}
  try { fs.rmSync(pDir, { recursive: true, force: true }) } catch (_) {}
  try { fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}
  await new Promise((r) => setTimeout(r, 500))
  process.exit(0)
}
