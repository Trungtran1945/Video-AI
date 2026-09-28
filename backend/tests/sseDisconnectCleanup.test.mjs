// SSE disconnect cleanup & listener leak tests (4.6 & 4.8)
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import express from 'express'
import { once } from 'node:events'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_sse_disc_clean_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const eventBus = (await import('../src/pipeline/eventBus.js')).default
const eventsRouter = (await import('../src/routes/v1/events.js')).default

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const user = { id: 'u-sse-disc', email: 'disc@test.local', role: 'user', password: 'pw' }
await insert('users', user)
const token = generateAccessToken(user)

const app = express()
app.use(express.json())
app.use('/api/v1', eventsRouter)
const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port

function requestSse(projectId) {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${port}/api/v1/projects/${projectId}/events`
    const headers = { authorization: `Bearer ${token}` }
    const req = http.get(url, { headers }, (res) => {
      resolve({ req, res })
    })
    req.on('error', (err) => {
      if (err.code === 'ECONNRESET' || err.message.includes('socket hang up')) {
        // expected when destroyed
        return
      }
      reject(err)
    })
  })
}

// 1. Single client disconnect cleans up listener and heartbeat
{
  const pid = `p-clean-1-${Date.now()}`
  await insert('projects', { id: pid, user_id: user.id, mode: 'TRANSLATE_DUB', title: 'clean', status: 'running', progress: 5 })
  const { req, res } = await requestSse(pid)
  await new Promise((r) => setTimeout(r, 100))
  assert(eventBus.listenerCount(`project:${pid}`) === 1, 'listener registered on connect')

  // Disconnect client
  req.destroy()
  await new Promise((r) => setTimeout(r, 100))
  assert(eventBus.listenerCount(`project:${pid}`) === 0, 'listener unsubscribed on client disconnect')
}

// 2. 10 rapid concurrent connect-then-disconnect cycles
{
  const pid = `p-clean-multi-${Date.now()}`
  await insert('projects', { id: pid, user_id: user.id, mode: 'TRANSLATE_DUB', title: 'clean multi', status: 'running', progress: 5 })

  for (let i = 0; i < 10; i++) {
    const { req } = await requestSse(pid)
    await new Promise((r) => setTimeout(r, 20))
    req.destroy()
    await new Promise((r) => setTimeout(r, 20))
  }

  await new Promise((r) => setTimeout(r, 100))
  assert(eventBus.listenerCount(`project:${pid}`) === 0, '10 rapid disconnects leave exactly 0 listeners')
}

// 3. Publishing to bus after client disconnect does not crash process or throw
{
  const pid = `p-clean-post-${Date.now()}`
  await insert('projects', { id: pid, user_id: user.id, mode: 'TRANSLATE_DUB', title: 'clean post', status: 'running', progress: 5 })
  const { req } = await requestSse(pid)
  await new Promise((r) => setTimeout(r, 50))
  req.destroy()
  await new Promise((r) => setTimeout(r, 50))

  let threw = false
  try {
    eventBus.publish(pid, { stage: 'dub.translate', percent: 50, status: 'running' })
    eventBus.publish(pid, { stage: '__project__', percent: 100, status: 'completed' })
  } catch (_) {
    threw = true
  }
  assert(!threw, 'publish after client disconnect is safe and does not throw')
  assert(eventBus.listenerCount(`project:${pid}`) === 0, '0 listeners remain after post-disconnect publish')
}

await new Promise((r) => server.close(r))
try { (await import('node:fs')).rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
if (failures > 0) process.exit(1)
