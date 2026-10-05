// BE-Q07: GET /providers/quota-summary (§4.7, §6 item 10).
// - Đặt trước /:provider/quota (không bị param-route nuốt).
// - 1 request thay N request; chỉ query providers có active key (+ ?providers= explicit).
// - Không expose keys/secrets; endpoint cũ còn hoạt động.
// Run: node tests/quotaSummary.test.mjs
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import express from 'express'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_qsummary_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const router = (await import('../src/routes/v1/providers.js')).default

await initSchema()

let failures = 0
const assert = (condition, message) => {
  if (condition) console.log('PASS:', message)
  else { failures += 1; console.error('FAIL:', message) }
}

const user = { id: randomUUID(), email: 'qsummary@test.local', role: 'user', password: 'test' }
await insert('users', user)
await insert('api_keys', { id: randomUUID(), user_id: user.id, provider: 'gemini', label: 'g', encrypted_key: 'enc1', is_active: 1 })
await insert('api_keys', { id: randomUUID(), user_id: user.id, provider: 'openai', label: 'o', encrypted_key: 'enc2', is_active: 1 })
await insert('api_keys', { id: randomUUID(), user_id: user.id, provider: 'elevenlabs', label: 'e', encrypted_key: 'enc3', is_active: 0 })

const app = express()
app.use(express.json())
app.use('/api/v1/providers', router)
const server = app.listen(0)
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}/api/v1/providers`
const token = generateAccessToken(user)
const get = (p) => fetch(`${base}${p}`, { headers: { authorization: `Bearer ${token}` } })

// 1 request thay N request; chỉ active providers (elevenlabs inactive không bị probe).
{
  const res = await get('/quota-summary')
  assert(res.status === 200, `quota-summary → 200 (got ${res.status})`)
  const body = await res.json()
  const names = Object.keys(body.providers || {}).sort()
  assert(names.includes('gemini') && names.includes('openai'), `có gemini+openai (got ${names})`)
  assert(!names.includes('elevenlabs'), 'provider không active key không bị query')
  const raw = JSON.stringify(body)
  assert(!/enc1|enc2|enc3|encrypted_key/i.test(raw), 'không expose keys/secrets')
  assert(typeof body.providers.gemini.usedToday === 'number', 'snapshot shape đầy đủ (usedToday)')
}

// ?providers= explicit (cho keyless providers như zerotts).
{
  const res = await get('/quota-summary?providers=elevenlabs,zerotts')
  const body = await res.json()
  const names = Object.keys(body.providers || {})
  assert(names.includes('elevenlabs') && names.includes('zerotts'), `explicit request được include (got ${names})`)
}

// Endpoint cũ còn hoạt động (backward-compat).
{
  const res = await get('/gemini/quota')
  assert(res.status === 200, `GET /:provider/quota cũ còn hoạt động (got ${res.status})`)
  const body = await res.json()
  assert(body.provider === 'gemini' && 'daily' in body && 'minute' in body, 'quota cũ có thêm daily/minute')
}

await new Promise((r) => server.close(r))
try { fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}
if (failures > 0) process.exit(1)
console.log('\nALL PASS')
