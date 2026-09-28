// Mask lifecycle (DRAFT -> APPROVED -> DISABLED) and output stale semantics (§4.4, §4.5, §4.11)
import path from 'node:path'
import os from 'node:os'
import express from 'express'
import { once } from 'node:events'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_mask_life_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const { createOutput, outputIsStale } = await import('../src/services/outputService.js')
const { loadSubtitleRegions } = await import('../src/pipeline/stages/dubRender.js')
const masksRouter = (await import('../src/routes/v1/masks.js')).default

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const user = { id: 'u-mask-life', email: 'mask-life@test.local', role: 'user', password: 'pw' }
await insert('users', user)
const token = generateAccessToken(user)

const projectId = `p-mask-life-${Date.now()}`
await insert('projects', { id: projectId, user_id: user.id, mode: 'TRANSLATE_DUB', title: 'mask lifecycle', transcript_version: 1 })

// Create an initial output rendered from revision 1
const outputId = `out-v1-${Date.now()}`
await createOutput({
  id: outputId,
  projectId,
  storageKey: 'outputs/v1.mp4',
  transcriptVersion: 1,
  durationSec: 10,
})

const app = express()
app.use(express.json())
app.use('/api/v1', masksRouter)
const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port

const baseUrl = `http://127.0.0.1:${port}/api/v1/projects/${projectId}/masks`

// Helper: check output staleness against current project revision
async function checkOutputFreshness() {
  const p = await queryOne('SELECT transcript_version FROM projects WHERE id = ?', [projectId])
  const o = await queryOne('SELECT transcript_version FROM outputs WHERE id = ?', [outputId])
  const stale = outputIsStale('TRANSLATE_DUB', p.transcript_version, o)
  return { projectVersion: p.transcript_version, stale }
}

// Initial state: output is fresh (v1 == v1)
{
  const { projectVersion, stale } = await checkOutputFreshness()
  assert(projectVersion === 1, 'initial project revision is 1')
  assert(stale === false, 'initial output is fresh (not stale)')
}

// 1. Create a DRAFT mask -> does not bump revision, output remains fresh
let draftMaskId
{
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2,
      startSec: 1, endSec: 3,
      status: 'DRAFT',
    }),
  })
  const data = await res.json()
  assert(res.status === 201, 'POST mask returns 201')
  assert(data.status === 'DRAFT', 'new mask defaults to DRAFT')
  draftMaskId = data.id

  const { projectVersion, stale } = await checkOutputFreshness()
  assert(projectVersion === 1, 'creating DRAFT mask does NOT bump revision')
  assert(stale === false, 'output remains fresh after DRAFT mask creation')

  // Verify loadSubtitleRegions excludes DRAFT
  const regions = await loadSubtitleRegions(projectId)
  assert(!regions.some((r) => r.id === draftMaskId), 'loadSubtitleRegions excludes DRAFT mask')
}

// 2. Approve the mask -> render-affecting! Bumps revision, marks output stale
{
  const res = await fetch(`${baseUrl}/${draftMaskId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'APPROVED' }),
  })
  const data = await res.json()
  assert(res.status === 200, 'Approve mask returns 200')
  assert(data.status === 'APPROVED', 'mask is APPROVED')

  const { projectVersion, stale } = await checkOutputFreshness()
  assert(projectVersion === 2, `approving mask bumps project revision (got ${projectVersion})`)
  assert(stale === true, 'output is now stale because APPROVED mask changed')

  // Verify loadSubtitleRegions includes APPROVED mask
  const regions = await loadSubtitleRegions(projectId)
  assert(regions.some((r) => r.id === draftMaskId), 'loadSubtitleRegions includes APPROVED mask')
}

// 3. Disable the APPROVED mask -> render-affecting! Bumps revision again
{
  const res = await fetch(`${baseUrl}/${draftMaskId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'DISABLED' }),
  })
  const data = await res.json()
  assert(res.status === 200, 'Disable mask returns 200')
  assert(data.status === 'DISABLED', 'mask is DISABLED')

  const { projectVersion } = await checkOutputFreshness()
  assert(projectVersion === 3, `disabling mask bumps project revision to 3 (got ${projectVersion})`)

  // Verify loadSubtitleRegions excludes DISABLED mask
  const regions = await loadSubtitleRegions(projectId)
  assert(!regions.some((r) => r.id === draftMaskId), 'loadSubtitleRegions excludes DISABLED mask')
}

// 4. Re-enable to APPROVED -> bumps revision to 4
{
  const res = await fetch(`${baseUrl}/${draftMaskId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'APPROVED' }),
  })
  assert(res.status === 200, 'Re-enable mask returns 200')
  const { projectVersion } = await checkOutputFreshness()
  assert(projectVersion === 4, `re-enabling mask bumps revision to 4 (got ${projectVersion})`)
}

// 5. Delete APPROVED mask -> bumps revision to 5
{
  const res = await fetch(`${baseUrl}/${draftMaskId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
  assert(res.status === 200, 'DELETE mask returns 200')
  const { projectVersion } = await checkOutputFreshness()
  assert(projectVersion === 5, `deleting APPROVED mask bumps revision to 5 (got ${projectVersion})`)
}

// 6. Delete DRAFT mask -> does NOT bump revision
{
  // Create another DRAFT mask
  const cRes = await fetch(baseUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2,
      startSec: 1, endSec: 3,
      status: 'DRAFT',
    }),
  })
  const cData = await cRes.json()
  const dId = cData.id

  // Delete DRAFT mask
  const dRes = await fetch(`${baseUrl}/${dId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
  assert(dRes.status === 200, 'DELETE DRAFT mask returns 200')
  const { projectVersion } = await checkOutputFreshness()
  assert(projectVersion === 5, 'deleting DRAFT mask does NOT bump revision (stays at 5)')
}

await new Promise((r) => server.close(r))
try { (await import('node:fs')).rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
if (failures > 0) process.exit(1)
