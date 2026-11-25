// Mask approve -> regenerate -> render integration test
// Proves:
// 1. DRAFT mask is excluded from render
// 2. Reject approving mask with invalid geometry or timing (API returns 400 identifying maskId)
// 3. Approving valid mask bumps transcript_version and marks status APPROVED
// 4. Regenerate/render applies the approved mask region into the FFmpeg filter chain
// 5. Render order invariant preserved: source -> mask -> ASS subtitle -> audio mix -> mux
// 6. Invalid APPROVED mask in DB causes BLOCK_RENDER: MASK_INVALID identifying the specific mask
// Run: node backend/tests/maskApproveRender.test.mjs
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { once } from 'node:events'
import express from 'express'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const runSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const tmpStorage = path.join(os.tmpdir(), `vidai_mask_approve_render_storage_${runSuffix}`)
// config.js actively reads STORAGE_DIR at import time and initializes uploads/outputs/tmp inside it.
process.env.STORAGE_DIR = tmpStorage
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const { insert, run, queryOne } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const masksRouter = (await import('../src/routes/v1/masks.js')).default
const { loadSubtitleRegions, getRegionValidationError } = await import('../src/pipeline/stages/dubRender.js')
const { buildMaskFilter } = await import('../src/media/mediaService.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else {
    failures++
    console.error('FAIL:', msg)
  }
}

const user = {
  id: `u-mask-approve-render-${runSuffix}`,
  email: `mask-approve-${runSuffix}@test.local`,
  role: 'user',
  password: 'pw',
}
await insert('users', user)
const token = generateAccessToken(user)

const projectId = `p-mask-appr-${runSuffix}`
await insert('projects', {
  id: projectId,
  user_id: user.id,
  mode: 'TRANSLATE_DUB',
  title: 'mask approve render test',
  transcript_version: 0,
  params: JSON.stringify({ enableDubbing: false, audioMode: 'ORIGINAL_ONLY' }),
})

const app = express()
app.use(express.json())
app.use('/api/v1', masksRouter)
const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/api/v1/projects/${projectId}/masks`

try {
  // ── 1. Create DRAFT mask & verify excluded from render ──
  console.log('\n--- TEST 1: Create DRAFT mask & verify excluded from render ---')
  const createRes = await fetch(baseUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2,
      startSec: 1.0, endSec: 3.0,
      type: 'blur', blurRadius: 8,
      status: 'DRAFT',
    }),
  })
  const created = await createRes.json()
  assert(createRes.status === 201, 'POST /masks creates DRAFT mask (201)')
  assert(created.status === 'DRAFT', 'new mask has status DRAFT')
  const maskId = created.id
  assert(maskId, 'new mask has valid id')

  // Before approval: loadSubtitleRegions must be empty
  let activeMasks = await loadSubtitleRegions(projectId)
  assert(activeMasks.length === 0, 'DRAFT mask is NOT loaded into render')

  // ── 2. Reject approving mask with invalid geometry or timing ──
  console.log('\n--- TEST 2: Reject approving mask with invalid geometry/timing with clear error ---')
  // Try approving with invalid timing (startSec >= endSec)
  const badTimingRes = await fetch(`${baseUrl}/${maskId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'APPROVED', startSec: 5.0, endSec: 2.0 }),
  })
  const badTimingData = await badTimingRes.json()
  assert(badTimingRes.status === 400, 'Approve with startSec >= endSec rejected with 400')
  assert(
    badTimingData?.error?.message?.includes(maskId) || badTimingData?.error?.details?.maskId === maskId,
    `error message or details identifies maskId for bad timing (got: ${JSON.stringify(badTimingData?.error)})`
  )

  // Try approving with invalid geometry (ratioW <= 0)
  const badGeoRes = await fetch(`${baseUrl}/${maskId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'APPROVED', ratioW: 0 }),
  })
  const badGeoData = await badGeoRes.json()
  assert(badGeoRes.status === 400, 'Approve with ratioW <= 0 rejected with 400')
  assert(
    badGeoData?.error?.message?.includes(maskId) && badGeoData?.error?.message?.includes('không hợp lệ để duyệt'),
    `error message identifies maskId and reason for bad geometry (got: ${badGeoData?.error?.message})`
  )

  // Verify mask remained in DRAFT in database
  const stillDraft = await queryOne('SELECT status FROM ocr_regions WHERE id = ?', [maskId])
  assert(stillDraft.status === 'DRAFT', 'mask remains DRAFT after rejected approve attempts')

  // ── 3. Approve valid mask -> bumps revision and changes status to APPROVED ──
  console.log('\n--- TEST 3: Approve valid mask bumps revision ---')
  const approveRes = await fetch(`${baseUrl}/${maskId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'APPROVED' }),
  })
  const approvedData = await approveRes.json()
  assert(approveRes.status === 200, 'PATCH /masks/:id with status: APPROVED succeeds (200)')
  assert(approvedData.status === 'APPROVED', 'returned status is APPROVED')

  // Verify project transcript_version was bumped
  const projectAfter = await queryOne('SELECT transcript_version FROM projects WHERE id = ?', [projectId])
  assert(projectAfter.transcript_version === 1, `transcript_version bumped to 1 (got: ${projectAfter.transcript_version})`)

  // ── 4. Regenerate / Render: Approved mask loaded and FFmpeg filter applied ──
  console.log('\n--- TEST 4: Regenerate/render applies mask region across flow ---')
  activeMasks = await loadSubtitleRegions(projectId, { maskMethod: 'blur' })
  assert(activeMasks.length === 1 && activeMasks[0].id === maskId, 'loadSubtitleRegions loads the APPROVED mask')
  assert(activeMasks[0].ratioX === 0.1 && activeMasks[0].ratioW === 0.8, 'loaded mask preserves exact ratio coordinates')

  // Test buildMaskFilter produces correct FFmpeg filter for the approved mask
  const filterResult = buildMaskFilter(activeMasks, { width: 1280, height: 720 })
  assert(filterResult && filterResult.isComplex === true, 'buildMaskFilter generates complex filter for blur mask')
  assert(
    filterResult.filter.includes('crop=1024:144:128:504,boxblur=8:1'),
    `filter contains pixel crop & boxblur coordinates (got: ${filterResult.filter})`
  )
  assert(
    filterResult.filter.includes("overlay=128:504:enable='between(t,1,3)'"),
    `filter contains overlay positioning and timing (got: ${filterResult.filter})`
  )

  // ── 5. Invariant check: Render order and BLOCK_RENDER in dubRender.js ──
  console.log('\n--- TEST 5: Render order invariant & BLOCK_RENDER preserved in dubRender.js ---')
  const dubRenderSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'stages', 'dubRender.js'), 'utf8')
  const fnBody = dubRenderSrc.slice(dubRenderSrc.indexOf('export async function dubRender'))
  const idxMask = fnBody.indexOf('applySubtitleMasks(')
  const idxBurn = fnBody.indexOf('burnSubtitlesStyled(')
  const idxDubTrack = fnBody.indexOf('buildDubTrack(')
  const idxMux = fnBody.indexOf('muxStream(')

  assert(idxMask > 0, 'dubRender invokes applySubtitleMasks')
  assert(idxBurn > 0, 'dubRender invokes burnSubtitlesStyled')
  assert(idxDubTrack > 0, 'dubRender invokes buildDubTrack')
  assert(idxMux > 0, 'dubRender invokes muxStream')

  assert(
    idxMask < idxBurn,
    'Render order: applySubtitleMasks runs BEFORE burnSubtitlesStyled (subtitles overlayed on top of mask)'
  )
  assert(
    idxBurn < idxDubTrack && idxDubTrack < idxMux,
    'Render order: ASS subtitles burned before audio track build and final mux'
  )
  assert(
    dubRenderSrc.includes('BLOCK_RENDER: MISSING_TTS_AUDIO'),
    'dubRender preserves BLOCK_RENDER: MISSING_TTS_AUDIO invariant'
  )
  assert(
    dubRenderSrc.includes("isTtsActive: enableDubbing && audioMode !== 'ORIGINAL_ONLY'"),
    "dubRender passes isTtsActive matching stagesForProject (shouldDub)"
  )

  // ── 6. Error surfacing when an APPROVED mask has invalid geometry in DB ──
  console.log('\n--- TEST 6: Malformed APPROVED mask identifies WHICH mask failed ---')
  const badMaskId = `m-bad-geometry-${runSuffix}`
  await insert('ocr_regions', {
    id: badMaskId,
    project_id: projectId,
    start_sec: 1.0,
    end_sec: 3.0,
    ratio_x: 0.1,
    ratio_y: 0.2,
    ratio_w: 0, // INVALID: zero width
    ratio_h: 0.3,
    status: 'APPROVED',
    enabled: 1,
  })

  let blockErr = null
  try {
    await loadSubtitleRegions(projectId)
  } catch (err) {
    blockErr = err
  }
  assert(blockErr !== null, 'loadSubtitleRegions throws on invalid APPROVED mask in DB')
  assert(blockErr?.code === 'BLOCK_RENDER', `error code is BLOCK_RENDER (got: ${blockErr?.code})`)
  assert(
    blockErr?.message?.includes(badMaskId),
    `error message identifies WHICH mask failed (expected '${badMaskId}' in '${blockErr?.message}')`
  )
  assert(
    blockErr?.message?.includes('BLOCK_RENDER: MASK_INVALID'),
    `error message has prefix BLOCK_RENDER: MASK_INVALID (got: ${blockErr?.message})`
  )
  assert(
    blockErr?.maskId === badMaskId,
    `error.maskId property identifies the failed mask (got: ${blockErr?.maskId})`
  )

  // Test getRegionValidationError helper
  const validationDetail = getRegionValidationError({ ratio_x: 0.1, ratio_y: 0.2, ratio_w: 0, ratio_h: 0.3, start_sec: 1, end_sec: 3 })
  assert(validationDetail?.includes('kích thước không hợp lệ'), `getRegionValidationError explains specific reason: ${validationDetail}`)
} finally {
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections()
  }
  await new Promise((r) => server.close(r))
  try { await run('DELETE FROM ocr_regions WHERE project_id = ?', [projectId]) } catch (_) {}
  try { await run('DELETE FROM projects WHERE id = ?', [projectId]) } catch (_) {}
  try { await run('DELETE FROM users WHERE id = ?', [user.id]) } catch (_) {}
  try {
    const { closePool } = await import('../src/db.js')
    await closePool()
  } catch (_) {}
  try { fs.rmSync(tmpStorage, { recursive: true, force: true }) } catch (_) {}
  await new Promise((r) => setTimeout(r, 200))
}

if (failures > 0) {
  console.error(`\nFAILED with ${failures} failure(s)`)
  process.exit(1)
} else {
  console.log('\nALL PASS: maskApproveRender integration suite passed completely!')
  process.exit(0)
}
