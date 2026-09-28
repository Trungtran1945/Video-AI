// Mask APPROVED immutability tests (§4.4)
import path from 'node:path'
import os from 'node:os'
import express from 'express'
import { once } from 'node:events'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_mask_immut_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const masksRouter = (await import('../src/routes/v1/masks.js')).default

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const user = { id: 'u-mask-immut', email: 'mask-immut@test.local', role: 'user', password: 'pw' }
await insert('users', user)
const token = generateAccessToken(user)

const projectId = `p-mask-immut-${Date.now()}`
await insert('projects', { id: projectId, user_id: user.id, mode: 'TRANSLATE_DUB', title: 'mask immut', transcript_version: 0 })

const app = express()
app.use(express.json())
app.use('/api/v1', masksRouter)
const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port

const baseUrl = `http://127.0.0.1:${port}/api/v1/projects/${projectId}/masks`

async function patchMask(maskId, body) {
  const res = await fetch(`${baseUrl}/${maskId}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

// 1. Setup an APPROVED mask
const maskId = `m-approved-${Date.now()}`
await insert('ocr_regions', {
  id: maskId,
  project_id: projectId,
  start_sec: 1.0,
  end_sec: 3.0,
  ratio_x: 0.1,
  ratio_y: 0.2,
  ratio_w: 0.5,
  ratio_h: 0.3,
  type: 'blur',
  blur_radius: 8,
  opacity: 1.0,
  enabled: 1,
  status: 'APPROVED',
  source: 'MANUAL',
})

// 2. Any attempt to modify geometry or visual parameters on APPROVED mask must return 409 MASK_APPROVED_IMMUTABLE
const testCases = [
  { field: 'ratioX', body: { ratioX: 0.2 } },
  { field: 'ratioY', body: { ratioY: 0.3 } },
  { field: 'ratioW', body: { ratioW: 0.6 } },
  { field: 'ratioH', body: { ratioH: 0.4 } },
  { field: 'startSec', body: { startSec: 1.5 } },
  { field: 'endSec', body: { endSec: 4.0 } },
  { field: 'type', body: { type: 'solid' } },
  { field: 'blurRadius', body: { blurRadius: 16 } },
  { field: 'opacity', body: { opacity: 0.8 } },
]

for (const tc of testCases) {
  const res = await patchMask(maskId, tc.body)
  assert(res.status === 409, `PATCH ${tc.field} on APPROVED returns 409 (got ${res.status})`)
  assert(res.data?.error?.code === 'MASK_APPROVED_IMMUTABLE', `error code is MASK_APPROVED_IMMUTABLE for ${tc.field}`)
}

// Verify mask in DB remained completely unchanged
const unchanged = await queryOne(`SELECT * FROM ocr_regions WHERE id = ?`, [maskId])
assert(unchanged.ratio_x === 0.1 && unchanged.start_sec === 1.0 && unchanged.status === 'APPROVED', 'APPROVED mask row untouched after 409s')

// 3. Status transition: APPROVED -> DISABLED (allowed)
{
  const res = await patchMask(maskId, { status: 'DISABLED' })
  assert(res.status === 200, 'APPROVED -> DISABLED succeeds (200)')
  assert(res.data.status === 'DISABLED' && res.data.enabled === false, 'status is DISABLED and enabled is false')
  const row = await queryOne(`SELECT status, enabled FROM ocr_regions WHERE id = ?`, [maskId])
  assert(row.status === 'DISABLED' && row.enabled === 0, 'DB row is DISABLED + 0')
}

// 4. Status transition: DISABLED -> APPROVED (allowed)
{
  const res = await patchMask(maskId, { status: 'APPROVED' })
  assert(res.status === 200, 'DISABLED -> APPROVED succeeds (200)')
  assert(res.data.status === 'APPROVED' && res.data.enabled === true, 'status is APPROVED and enabled is true')
  const row = await queryOne(`SELECT status, enabled FROM ocr_regions WHERE id = ?`, [maskId])
  assert(row.status === 'APPROVED' && row.enabled === 1, 'DB row is APPROVED + 1')
}

// 5. Explicit reset to DRAFT -> edit -> re-approve
{
  // Reset to DRAFT
  const resetRes = await patchMask(maskId, { status: 'DRAFT' })
  assert(resetRes.status === 200, 'APPROVED -> DRAFT succeeds (200)')
  assert(resetRes.data.status === 'DRAFT', 'status is DRAFT')

  // Now in DRAFT, geometry edit is permitted
  const editRes = await patchMask(maskId, { ratioX: 0.35, ratioW: 0.45, startSec: 2.0, endSec: 5.0 })
  assert(editRes.status === 200, 'DRAFT geometry edit succeeds (200)')
  assert(editRes.data.ratioX === 0.35 && editRes.data.startSec === 2.0, 'new geometry saved in DRAFT')

  // Re-approve with new geometry
  const reApprove = await patchMask(maskId, { status: 'APPROVED' })
  assert(reApprove.status === 200, 'DRAFT re-approve succeeds (200)')
  assert(reApprove.data.status === 'APPROVED' && reApprove.data.ratioX === 0.35, 're-approved with updated geometry')
}

await new Promise((r) => server.close(r))
try { (await import('node:fs')).rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
if (failures > 0) process.exit(1)
