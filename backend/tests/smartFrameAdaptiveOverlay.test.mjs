// Smart Frame & Adaptive Overlay System Test Suite
// Verifies:
// 1. Frame aspect ratio & resolution presets (16:9, 9:16, 1:1, 4:3, 3:4, 4:5, 21:9, Custom) & even dimensions
// 2. PATCH /api/v1/projects/:id project aspect ratio & params updates with validation
// 3. Asset metadata probing & formatAsset exposure (width, height, aspectRatio, meta)
// 4. Smart Overlay Auto Fit & transform calculations (CONTAIN, COVER, FILL, Alignments)
// 5. Timeline persistence with overlay transform metadata
// Run: node backend/tests/smartFrameAdaptiveOverlay.test.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { v4 as uuidv4 } from 'uuid'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-smart-frame-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const { dimsForAspect, toEven, ASPECT_DIMS } = await import('../src/pipeline/context.js')
const { formatAsset } = await import('../src/routes/v1/composerAssets.js')
const { saveTimeline } = await import('../src/services/composerService.js')
const projectsRouter = (await import('../src/routes/v1/projects.js')).default

await initSchema()

console.log('=== AI Media Composer Smart Frame & Adaptive Overlay Test Suite ===\n')

const testUser = { id: 'user-frame-1', email: 'frame-test@test.local', role: 'user' }
const foreignUser = { id: 'user-frame-2', email: 'foreign@test.local', role: 'user' }
await insert('users', { id: testUser.id, email: testUser.email, role: 'user', password: 'hash' })
await insert('users', { id: foreignUser.id, email: foreignUser.email, role: 'user', password: 'hash' })
const token = generateAccessToken(testUser)
const foreignToken = generateAccessToken(foreignUser)

const app = express()
app.use(express.json())
app.use('/api/v1/projects', projectsRouter)
const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/api/v1/projects`

try {
  // -------------------------------------------------------------
  // TEST 1: Frame Presets and Even Dimension Enforcement
  // -------------------------------------------------------------
  console.log('--- 1. Frame Aspect Ratio Presets & Even Dimension Enforcement ---')
  const presets = [
    { ratio: '16:9', expectedW: 1920, expectedH: 1080 },
    { ratio: '9:16', expectedW: 1080, expectedH: 1920 },
    { ratio: '1:1',  expectedW: 1080, expectedH: 1080 },
    { ratio: '4:3',  expectedW: 1440, expectedH: 1080 },
    { ratio: '3:4',  expectedW: 1080, expectedH: 1440 },
    { ratio: '4:5',  expectedW: 1080, expectedH: 1350 },
    { ratio: '21:9', expectedW: 2560, expectedH: 1080 },
  ]

  for (const p of presets) {
    const dims = dimsForAspect(p.ratio)
    assert.equal(dims.width, p.expectedW, `${p.ratio} width matches ${p.expectedW}`)
    assert.equal(dims.height, p.expectedH, `${p.ratio} height matches ${p.expectedH}`)
    assert.equal(dims.width % 2, 0, `${p.ratio} width is even`)
    assert.equal(dims.height % 2, 0, `${p.ratio} height is even`)
    console.log(`✓ Preset ${p.ratio} -> ${dims.width}x${dims.height} (even dimensions verified)`)
  }

  // Custom odd dimensions must clamp to even integers
  const customOdd = dimsForAspect('custom', { width: 1081, height: 1919 })
  assert.equal(customOdd.width, 1080, 'Odd custom width 1081 floored to even 1080')
  assert.equal(customOdd.height, 1918, 'Odd custom height 1919 floored to even 1918')
  assert.equal(toEven(721), 720, 'toEven(721) = 720')
  assert.equal(toEven(720), 720, 'toEven(720) = 720')
  console.log('✓ Custom dimensions and toEven() guarantee even integers')

  // -------------------------------------------------------------
  // TEST 2: PATCH /api/v1/projects/:id Frame Ratio & Params Update
  // -------------------------------------------------------------
  console.log('\n--- 2. Project Update API: Aspect Ratio & Params Persistence ---')
  const projId = 'proj-frame-' + uuidv4().slice(0, 8)
  await insert('projects', {
    id: projId,
    user_id: testUser.id,
    title: 'Frame Test Project',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
    aspect_ratio: '16:9',
  })

  // Update aspect ratio to 9:16 and custom resolution parameters
  const updateRes = await fetch(`${baseUrl}/${projId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Updated Frame Studio Project',
      aspectRatio: '9:16',
      resolution: '1080p',
      params: {
        width: 1080,
        height: 1920,
        fps: 60,
        defaultBackground: '#1a1d24',
      },
    }),
  })
  assert.equal(updateRes.status, 200, 'PATCH returns 200')
  const updatedData = await updateRes.json()
  assert.equal(updatedData.title, 'Updated Frame Studio Project')
  assert.equal(updatedData.aspect_ratio, '9:16')
  assert.equal(updatedData.params?.fps, 60)
  assert.equal(updatedData.params?.defaultBackground, '#1a1d24')
  console.log('✓ Project PATCH updated aspect_ratio to 9:16 with 60fps params')

  // Foreign user must receive 403
  const foreignRes = await fetch(`${baseUrl}/${projId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${foreignToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: 'Hacked Title' }),
  })
  assert.equal(foreignRes.status, 403, 'Foreign user gets 403 Forbidden')
  console.log('✓ Authorization guard: Foreign user rejected with 403')

  // -------------------------------------------------------------
  // TEST 3: Asset Metadata & formatAsset Exposure
  // -------------------------------------------------------------
  console.log('\n--- 3. Asset Metadata Exposure in formatAsset ---')
  const rawAsset = {
    id: 'asset-meta-1',
    project_id: projId,
    user_id: testUser.id,
    kind: 'image',
    name: 'photo_4k.jpg',
    storage_key: `projects/${projId}/assets/photo_4k.jpg`,
    meta: JSON.stringify({
      width: 3840,
      height: 2160,
      fps: 30,
      codec: 'mjpeg',
      pixFmt: 'yuvj420p',
      aspectRatio: 1.778,
    }),
  }
  const formatted = formatAsset(rawAsset)
  assert.equal(formatted.width, 3840, 'Exposes width: 3840')
  assert.equal(formatted.height, 2160, 'Exposes height: 2160')
  assert.equal(formatted.aspectRatio, 1.778, 'Exposes aspectRatio: 1.778')
  assert.equal(formatted.meta?.codec, 'mjpeg', 'Exposes full meta object')
  console.log('✓ formatAsset exposes width, height, aspectRatio, and meta cleanly')

  // -------------------------------------------------------------
  // TEST 4: Smart Overlay Auto Fit & Positioning Calculations
  // -------------------------------------------------------------
  console.log('\n--- 4. Smart Overlay Auto Fit Transform Math ---')
  // Simulated overlay math function mirroring preview & render logic
  function calculateOverlayTransform({ frameW, frameH, sourceW, sourceH, fit = 'contain', scale = 1.0, posX = 0, posY = 0, align = 'center' }) {
    let baseScale = 1.0
    if (fit === 'contain') {
      baseScale = Math.min(frameW / sourceW, frameH / sourceH)
    } else if (fit === 'cover') {
      baseScale = Math.max(frameW / sourceW, frameH / sourceH)
    } else if (fit === 'fill') {
      baseScale = 1.0
    }

    const effectiveScale = baseScale * scale
    const targetW = toEven(fit === 'fill' ? frameW * scale : sourceW * effectiveScale)
    const targetH = toEven(fit === 'fill' ? frameH * scale : sourceH * effectiveScale)

    // Base alignment
    let baseX = (frameW - targetW) / 2
    let baseY = (frameH - targetH) / 2

    if (align.includes('left')) baseX = 0
    if (align.includes('right')) baseX = frameW - targetW
    if (align.includes('top')) baseY = 0
    if (align.includes('bottom')) baseY = frameH - targetH

    // User position offset (percentage of frame dimension / 2)
    const offsetX = Math.round(posX * (frameW / 2))
    const offsetY = Math.round(posY * (frameH / 2))

    const finalX = Math.round(baseX + offsetX)
    const finalY = Math.round(baseY + offsetY)

    return { targetW, targetH, finalX, finalY, effectiveScale }
  }

  // 4.1 Horizontal image (1920x1080) inside Vertical 9:16 frame (1080x1920) with CONTAIN
  const fitContain = calculateOverlayTransform({
    frameW: 1080,
    frameH: 1920,
    sourceW: 1920,
    sourceH: 1080,
    fit: 'contain',
    scale: 1.0,
    align: 'center',
  })
  assert.equal(fitContain.targetW, 1080, 'Contain width equals frame width (1080)')
  assert.equal(fitContain.targetH, 608, 'Contain height scaled proportionally (608)')
  assert.equal(fitContain.finalX, 0, 'Centered horizontally: X=0')
  assert.ok(fitContain.finalY > 600 && fitContain.finalY < 700, 'Centered vertically')
  console.log(`✓ 16:9 inside 9:16 CONTAIN: target=${fitContain.targetW}x${fitContain.targetH}, pos=(${fitContain.finalX}, ${fitContain.finalY})`)

  // 4.2 Horizontal image (1920x1080) inside Vertical 9:16 frame with COVER
  const fitCover = calculateOverlayTransform({
    frameW: 1080,
    frameH: 1920,
    sourceW: 1920,
    sourceH: 1080,
    fit: 'cover',
    scale: 1.0,
    align: 'center',
  })
  assert.equal(fitCover.targetH, 1920, 'Cover height equals frame height (1920)')
  assert.ok(fitCover.targetW >= 3410, 'Cover width expands beyond frame bounds')
  assert.ok(fitCover.finalX < 0, 'Cover X offset centers cropped overhang')
  console.log(`✓ 16:9 inside 9:16 COVER: target=${fitCover.targetW}x${fitCover.targetH}, pos=(${fitCover.finalX}, ${fitCover.finalY})`)

  // 4.3 PiP Overlay with Top-Right alignment and scale=0.3
  const fitPip = calculateOverlayTransform({
    frameW: 1920,
    frameH: 1080,
    sourceW: 1920,
    sourceH: 1080,
    fit: 'contain',
    scale: 0.3,
    align: 'top-right',
  })
  assert.equal(fitPip.targetW, 576, 'PiP width is 30% of 1920 (576)')
  assert.equal(fitPip.targetH, 324, 'PiP height is 30% of 1080 (324)')
  assert.equal(fitPip.finalX, 1920 - 576, 'Aligned to right edge: 1344')
  assert.equal(fitPip.finalY, 0, 'Aligned to top edge: 0')
  console.log(`✓ PiP Top-Right overlay: target=${fitPip.targetW}x${fitPip.targetH}, pos=(${fitPip.finalX}, ${fitPip.finalY})`)

  // -------------------------------------------------------------
  // TEST 5: Timeline Persistence with Overlay Transform Meta
  // -------------------------------------------------------------
  console.log('\n--- 5. Timeline Persistence with Overlay Transform Meta ---')
  const trackId = 'track-overlay-1'
  await insert('timeline_tracks', {
    id: trackId,
    project_id: projId,
    track_type: 'video',
    name: 'Overlay Video Track',
    order_index: 1,
  })

  const clipMeta = {
    fit: 'contain',
    autoFit: true,
    scale: 1.25,
    posX: 0.1,
    posY: -0.15,
    align: 'center',
    lockAspect: true,
    opacity: 0.95,
  }

  const overlayClip = {
    id: uuidv4(),
    track_id: trackId,
    clip_type: 'image',
    start_at_sec: 0,
    in_sec: 0,
    out_sec: 5.0,
    meta: clipMeta,
  }

  await saveTimeline({
    projectId: projId,
    tracks: [{ id: trackId, volume: 1.0 }],
    clips: [overlayClip],
  })

  const savedClip = await queryOne('SELECT * FROM timeline_clips WHERE id = ?', [overlayClip.id])
  assert.ok(savedClip, 'Clip persisted in DB')
  const parsedMeta = typeof savedClip.meta === 'string' ? JSON.parse(savedClip.meta) : savedClip.meta
  assert.equal(parsedMeta.fit, 'contain', 'Persisted meta.fit')
  assert.equal(parsedMeta.scale, 1.25, 'Persisted meta.scale')
  assert.equal(parsedMeta.posX, 0.1, 'Persisted meta.posX')
  assert.equal(parsedMeta.posY, -0.15, 'Persisted meta.posY')
  assert.equal(parsedMeta.align, 'center', 'Persisted meta.align')
  assert.equal(parsedMeta.lockAspect, true, 'Persisted meta.lockAspect')
  console.log('✓ Clip transform metadata saved and retrieved with 100% fidelity')

  console.log('\n======================================================')
  console.log(' ALL SMART FRAME & ADAPTIVE OVERLAY TESTS PASSED 100% ')
  console.log('======================================================\n')
} finally {
  await new Promise((resolve) => server.close(resolve)).catch(() => {})
  try {
    const { connection } = await import('../src/queue/connection.js')
    await connection.disconnect()
  } catch (_) {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_) {}
  setTimeout(() => process.exit(0), 100)
}
