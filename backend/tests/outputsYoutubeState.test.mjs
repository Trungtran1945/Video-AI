import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import express from 'express'
import { once } from 'node:events'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_outputs_yt_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)
process.env.JWT_SECRET = 'test-secret-outputs-yt-state'

const { initSchema } = await import('../src/db/schema.js')
const { insert } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const router = (await import('../src/routes/v1/outputs.js')).default

await initSchema()

let failures = 0
const assert = (condition, message) => {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

let server = null
try {
  console.log('=== outputsYoutubeState.test.mjs ===')

  const user1 = { id: 'yt-out-user-1', email: 'user1@test.local', role: 'user', password: 'test' }
  const user2 = { id: 'yt-out-user-2', email: 'user2@test.local', role: 'user', password: 'test' }
  const admin = { id: 'yt-out-admin', email: 'admin@test.local', role: 'admin', password: 'test' }

  await insert('users', user1)
  await insert('users', user2)
  await insert('users', admin)

  const tokenUser1 = generateAccessToken(user1)
  const tokenUser2 = generateAccessToken(user2)
  const tokenAdmin = generateAccessToken(admin)

  // Projects
  await insert('projects', { id: 'proj-1', user_id: user1.id, mode: 'SCRIPT_TO_VIDEO', title: 'User 1 Project', script_version: 1 })
  await insert('projects', { id: 'proj-2', user_id: user2.id, mode: 'TRANSLATE_DUB', title: 'User 2 Project', transcript_version: 1 })

  // Outputs
  const out1WithYt = 'out-1-yt'
  const out2NoYt = 'out-2-noyt'
  const out3User2 = 'out-3-user2'

  await insert('outputs', {
    id: out1WithYt,
    project_id: 'proj-1',
    storage_key: 'projects/proj-1/final.mp4',
    status: 'success',
    duration_sec: 25,
    script_version: 1,
    created_date: '2026-11-03T08:00:00Z',
  })

  await insert('outputs', {
    id: out2NoYt,
    project_id: 'proj-1',
    storage_key: 'projects/proj-1/another.mp4',
    status: 'success',
    duration_sec: 10,
    script_version: 1,
    created_date: '2026-11-03T07:00:00Z',
  })

  await insert('outputs', {
    id: out3User2,
    project_id: 'proj-2',
    storage_key: 'projects/proj-2/final.mp4',
    status: 'success',
    duration_sec: 30,
    transcript_version: 1,
    created_date: '2026-11-03T09:00:00Z',
  })

  // YouTube Uploads
  await insert('youtube_uploads', {
    id: 'yt-rec-1',
    output_id: out1WithYt,
    project_id: 'proj-1',
    status: 'completed',
    youtube_video_id: 'vid123',
    youtube_url: 'https://youtu.be/vid123',
    privacy: 'unlisted',
    progress: 100,
    error_message: null,
    created_date: '2026-11-03T08:05:00Z',
  })

  await insert('youtube_uploads', {
    id: 'yt-rec-3',
    output_id: out3User2,
    project_id: 'proj-2',
    status: 'uploading',
    youtube_video_id: null,
    youtube_url: null,
    privacy: 'private',
    progress: 65,
    error_message: null,
    created_date: '2026-11-03T09:05:00Z',
  })

  const app = express()
  app.use(express.json())
  app.use('/api/v1/outputs', router)

  server = app.listen(0)
  await once(server, 'listening')
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}/api/v1/outputs`

  // 1. GET /outputs as User 1
  const res1 = await fetch(base, { headers: { authorization: `Bearer ${tokenUser1}` } })
  assert(res1.status === 200, 'GET /outputs returns 200 for regular user')
  const list1 = await res1.json()
  assert(list1.length === 2, `User 1 sees exactly 2 outputs (got ${list1.length})`)

  const item1 = list1.find((o) => o.id === out1WithYt)
  const item2 = list1.find((o) => o.id === out2NoYt)

  assert(item1 && item1.youtubeUpload !== null, 'Output 1 has youtubeUpload attached')
  assert(item1?.youtubeUpload?.status === 'completed', 'Output 1 youtubeUpload status is completed')
  assert(item1?.youtubeUpload?.youtubeVideoId === 'vid123', 'Output 1 youtubeVideoId is vid123')
  assert(item1?.youtubeUpload?.youtubeVideoUrl === 'https://youtu.be/vid123', 'Output 1 youtubeVideoUrl is https://youtu.be/vid123')
  assert(item1?.youtubeUpload?.privacy === 'unlisted', 'Output 1 privacy is unlisted')

  assert(item2 && item2.youtubeUpload === null, 'Output 2 youtubeUpload is null')

  // 2. GET /outputs/:id as User 1
  const resOut1 = await fetch(`${base}/${out1WithYt}`, { headers: { authorization: `Bearer ${tokenUser1}` } })
  assert(resOut1.status === 200, 'GET /outputs/:id returns 200 for owner')
  const detail1 = await resOut1.json()
  assert(detail1.youtubeUpload !== null, 'Detail 1 has youtubeUpload attached')
  assert(detail1.youtubeUpload?.status === 'completed', 'Detail 1 youtubeUpload status is completed')

  const resOut3Forbidden = await fetch(`${base}/${out3User2}`, { headers: { authorization: `Bearer ${tokenUser1}` } })
  assert(resOut3Forbidden.status === 403, 'GET /outputs/:id returns 403 when requesting other user output')

  // 3. GET /outputs as Admin
  const resAdmin = await fetch(base, { headers: { authorization: `Bearer ${tokenAdmin}` } })
  assert(resAdmin.status === 200, 'GET /outputs returns 200 for admin')
  const listAdmin = await resAdmin.json()
  assert(listAdmin.length === 3, `Admin sees all 3 outputs (got ${listAdmin.length})`)

  const adminItem3 = listAdmin.find((o) => o.id === out3User2)
  assert(adminItem3?.youtubeUpload?.status === 'uploading', 'Admin sees uploading status for output 3')
  assert(adminItem3?.youtubeUpload?.progress === 65, 'Admin sees progress 65% for output 3')

  // 4. GET /outputs?projectId=
  const resProjFilter = await fetch(`${base}?projectId=proj-1`, { headers: { authorization: `Bearer ${tokenUser1}` } })
  assert(resProjFilter.status === 200, 'GET /outputs?projectId= returns 200')
  const projFilteredList = await resProjFilter.json()
  assert(projFilteredList.length === 2, 'Project filter works accurately')

  if (failures > 0) {
    console.error(`\n${failures} TEST(S) FAILED`)
    process.exit(1)
  }
  console.log('\nALL PASS')
} catch (err) {
  console.error('Unhandled error in test:', err)
  process.exit(1)
} finally {
  if (server) {
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
  }
  try {
    if (process.env.DB_PATH && fs.existsSync(process.env.DB_PATH)) {
      fs.unlinkSync(process.env.DB_PATH)
    }
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 200))
  process.exit(failures > 0 ? 1 : 0)
}
