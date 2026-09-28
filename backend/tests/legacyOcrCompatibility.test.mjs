// Legacy OCR compatibility & source isolation tests (§4.1 & §4.2)
import path from 'node:path'
import os from 'node:os'
import express from 'express'
import { once } from 'node:events'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_legacy_ocr_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, run } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const { deriveAutoRegions, loadSubtitleRegions } = await import('../src/pipeline/stages/dubRender.js')
const masksRouter = (await import('../src/routes/v1/masks.js')).default

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const user = { id: 'u-leg-ocr', email: 'leg@test.local', role: 'user', password: 'pw' }
await insert('users', user)
const token = generateAccessToken(user)

const projectId = `p-leg-ocr-${Date.now()}`
await insert('projects', { id: projectId, user_id: user.id, mode: 'TRANSLATE_DUB', title: 'legacy ocr' })

// Populate transcript_segments with various sources
// Row 1: Explicit legacy OCR with bbox
await insert('transcript_segments', {
  id: 'seg-leg-1',
  project_id: projectId,
  index_num: 0,
  start_sec: 1.0,
  end_sec: 3.0,
  text: 'Hardsub text',
  source: 'ocr',
  ratio_x: 0.1, ratio_y: 0.8, ratio_w: 0.8, ratio_h: 0.15,
})

// Row 2: Legacy row with source IS NULL and bbox -> MUST NOT be treated as OCR
await insert('transcript_segments', {
  id: 'seg-null-source',
  project_id: projectId,
  index_num: 1,
  start_sec: 4.0,
  end_sec: 6.0,
  text: 'Unknown source text',
  source: null,
  ratio_x: 0.1, ratio_y: 0.8, ratio_w: 0.8, ratio_h: 0.15,
})

// Row 3: Modern STT row with source 'asr'
await insert('transcript_segments', {
  id: 'seg-asr',
  project_id: projectId,
  index_num: 2,
  start_sec: 7.0,
  end_sec: 9.0,
  text: 'ASR text',
  source: 'asr',
  ratio_x: null, ratio_y: null, ratio_w: null, ratio_h: null,
})

// Row 4: OCR row with missing bbox
await insert('transcript_segments', {
  id: 'seg-ocr-nobbox',
  project_id: projectId,
  index_num: 3,
  start_sec: 10.0,
  end_sec: 12.0,
  text: 'OCR no bbox',
  source: 'ocr',
  ratio_x: null, ratio_y: null, ratio_w: null, ratio_h: null,
})

// 1. deriveAutoRegions test
{
  const auto = await deriveAutoRegions(projectId)
  assert(auto.length === 1, `deriveAutoRegions returns exactly 1 row (got ${auto.length})`)
  assert(auto[0].id === 'legacy_ocr:seg-leg-1', 'matches explicit OCR row')
  assert(auto[0].source === 'LEGACY_OCR', 'source is LEGACY_OCR')
  assert(auto[0].status === 'DRAFT', 'status is DRAFT (not auto-approved)')
  assert(auto[0].enabled === 0, 'enabled is 0')
  assert(auto[0].isLegacy === true, 'isLegacy is true')
}

// 2. loadSubtitleRegions in current STT-only runtime does NOT include legacy OCR
{
  const regions = await loadSubtitleRegions(projectId)
  assert(regions.length === 0, 'loadSubtitleRegions returns [] for STT-only (no auto-derive)')
}

// 3. GET /projects/:id/masks API endpoint test
const app = express()
app.use(express.json())
app.use('/api/v1', masksRouter)
const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port

const baseUrl = `http://127.0.0.1:${port}/api/v1/projects/${projectId}/masks`

{
  const res = await fetch(baseUrl, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert(res.status === 200, 'GET /masks returns 200')
  const body = await res.json()
  const masks = body.masks || []
  const legacyMask = masks.find((m) => m.id === 'legacy_ocr:seg-leg-1')
  assert(!!legacyMask, 'legacy mask present in API')
  assert(legacyMask.source === 'LEGACY_OCR', 'API reports source: LEGACY_OCR')
  assert(legacyMask.status === 'DRAFT', 'API reports status: DRAFT')
  assert(legacyMask.enabled === false, 'API reports enabled: false')
  assert(legacyMask.isLegacy === true, 'API reports isLegacy: true')

  // Unknown null source not in API masks
  assert(!masks.some((m) => m.id.includes('seg-null-source')), 'null source not derived as mask')
}

// 4. Legacy masks cannot be mutated directly
{
  const patchRes = await fetch(`${baseUrl}/legacy_ocr:seg-leg-1`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ratioX: 0.2 }),
  })
  assert(patchRes.status === 400, 'PATCH legacy mask returns 400')
  const patchBody = await patchRes.json()
  assert(patchBody.error?.message?.includes('chỉ đọc'), 'returns read-only validation error')

  const delRes = await fetch(`${baseUrl}/legacy_ocr:seg-leg-1`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
  assert(delRes.status === 400, 'DELETE legacy mask returns 400')
}

await new Promise((r) => server.close(r))
try { (await import('node:fs')).rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
if (failures > 0) process.exit(1)
