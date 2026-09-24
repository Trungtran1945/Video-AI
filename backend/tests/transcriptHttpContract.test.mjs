import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import express from 'express'
import { once } from 'node:events'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_transcript_http_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, run } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const router = (await import('../src/routes/v1/dubData.js')).default

await initSchema()

let failures = 0
const assert = (condition, message) => {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

const user = { id: 'http-transcript-user', email: 'http-transcript@test.local', role: 'user', password: 'test' }
const projectId = 'http-transcript-project'
await insert('users', user)
await insert('projects', { id: projectId, user_id: user.id, mode: 'TRANSLATE_DUB', title: 'http transcript' })
await insert('transcript_segments', {
  id: 'http-transcript-segment',
  project_id: projectId,
  index_num: 0,
  start_sec: 0,
  end_sec: 2,
  text: 'hello',
  translation: 'xin chào',
})

const app = express()
app.use(express.json())
app.use('/api/v1', router)
const server = app.listen(0)
await once(server, 'listening')
const address = server.address()
const baseUrl = `http://127.0.0.1:${address.port}/api/v1/projects/${projectId}/transcript`
const token = generateAccessToken(user)
const request = (body) => fetch(baseUrl, {
  method: 'PUT',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const missing = await request({ segments: [{ id: 'http-transcript-segment', translation: 'legacy' }] })
const missingBody = await missing.json()
assert(missing.status === 400 && missingBody.error.code === 'VAL_001', 'PUT without revision returns HTTP 400')

const first = await request({ revision: 0, segments: [{ id: 'http-transcript-segment', translation: 'A' }] })
const firstBody = await first.json()
assert(first.status === 200 && firstBody.revision === 1, 'PUT with current revision commits once')

const concurrent = await Promise.all([
  request({ revision: 1, segments: [{ id: 'http-transcript-segment', translation: 'B' }] }),
  request({ revision: 1, segments: [{ id: 'http-transcript-segment', translation: 'C' }] }),
])
const concurrentBodies = await Promise.all(concurrent.map((response) => response.json()))
const statuses = concurrent.map((response) => response.status).sort()
assert(statuses[0] === 200 && statuses[1] === 409, 'two clients at one revision produce one commit and one conflict')
assert(concurrentBodies.some((body) => body.error?.code === 'CONFLICT_001'), 'conflict uses the stable public error code')

await new Promise((resolve) => server.close(resolve))
await run('DELETE FROM transcript_segments WHERE project_id = ?', [projectId])
await run('DELETE FROM projects WHERE id = ?', [projectId])
await run('DELETE FROM users WHERE id = ?', [user.id])
fs.rmSync(process.env.DB_PATH, { force: true })
if (failures > 0) process.exit(1)
console.log('ALL PASS')
