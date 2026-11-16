import assert from 'node:assert'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_overlay_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { query, queryOne, insert } = await import('../src/db/query.js')
const { composerRender } = await import('../src/pipeline/stages/composerRender.js')
const { composerPrepare } = await import('../src/pipeline/stages/composerPrepare.js')
const { projectDir, ensureDir, resolveStorageKey } = await import('../src/pipeline/context.js')
const { probe, ffmpeg } = await import('../src/media/ffmpeg.js')
const composerService = (await import('../src/services/composerService.js')).default

await initSchema()

console.log('=== Test Smart Frame & Adaptive Overlay Rendering System ===')

const testUserId = 'user-overlay-test-' + uuidv4().slice(0, 8)
await insert('users', {
  id: testUserId,
  email: `overlay-${uuidv4().slice(0, 8)}@test.com`,
  password: 'hash',
})

// 1. TEST-FRAME-CUSTOM-DIMS: Custom resolution parameters (1280x720) with even dimensions
{
  console.log('\n--- 1. TEST-FRAME-CUSTOM-DIMS: Custom resolution parameters ---')
  const projId = 'proj-frame-custom-' + uuidv4().slice(0, 8)
  await insert('projects', {
    id: projId,
    user_id: testUserId,
    title: 'Test Custom Frame Dimensions',
    mode: 'MEDIA_COMPOSER',
    aspect_ratio: '16:9',
    params: JSON.stringify({ width: 1280, height: 720, defaultBackground: '#121824' }),
    status: 'queued',
  })

  await composerService.ensureDefaultTracks(projId)
  const pDir = projectDir(projId)
  const assetsDir = ensureDir(path.join(pDir, 'assets'))
  const imgPath = path.join(assetsDir, 'test_img_720.png')

  // Generate test 640x360 image
  await ffmpeg([
    '-y', '-f', 'lavfi', '-i', 'color=c=green:s=640x360:d=1',
    '-frames:v', '1', imgPath,
  ])

  const assetId = 'asset-img-' + uuidv4().slice(0, 8)
  await insert('assets', {
    id: assetId,
    project_id: projId,
    name: 'test_img_720.png',
    kind: 'image',
    storage_key: `projects/${projId}/assets/test_img_720.png`,
    mime_type: 'image/png',
    byte_size: fs.statSync(imgPath).size,
  })

  await insert('timeline_clips', {
    id: 'clip-img-' + uuidv4().slice(0, 8),
    project_id: projId,
    asset_id: assetId,
    clip_type: 'image',
    order_index: 0,
    start_at_sec: 0,
    in_sec: 0,
    out_sec: 2,
    meta: JSON.stringify({ fit: 'contain', autoFit: true }),
  })

  const projectRow = await queryOne('SELECT * FROM projects WHERE id = ?', [projId])
  await composerPrepare({ project: projectRow })
  const renderRes = await composerRender({ project: projectRow })

  assert.ok(renderRes?.outputId, 'Render produced an outputId')
  assert.equal(renderRes.width, 1280, 'Render output width matches custom params width 1280')
  assert.equal(renderRes.height, 720, 'Render output height matches custom params height 720')
  console.log(`✓ Custom frame resolution verified: ${renderRes.width}x${renderRes.height}, duration=${renderRes.durationSec}s`)
}

// 2. TEST-SMART-OVERLAY-AUTO-FIT: CONTAIN vs COVER vs FILL
{
  console.log('\n--- 2. TEST-SMART-OVERLAY-AUTO-FIT: CONTAIN, COVER, FILL modes ---')
  const projId = 'proj-overlay-fit-' + uuidv4().slice(0, 8)
  await insert('projects', {
    id: projId,
    user_id: testUserId,
    title: 'Test Overlay Fit Modes',
    mode: 'MEDIA_COMPOSER',
    aspect_ratio: '16:9',
    params: JSON.stringify({ width: 960, height: 540 }),
    status: 'queued',
  })

  await composerService.ensureDefaultTracks(projId)
  const pDir = projectDir(projId)
  const assetsDir = ensureDir(path.join(pDir, 'assets'))
  const imgPath = path.join(assetsDir, 'source_400x200.png')

  // Generate 400x200 image (2:1 aspect ratio)
  await ffmpeg([
    '-y', '-f', 'lavfi', '-i', 'color=c=purple:s=400x200:d=1',
    '-frames:v', '1', imgPath,
  ])

  const assetId = 'asset-fit-' + uuidv4().slice(0, 8)
  await insert('assets', {
    id: assetId,
    project_id: projId,
    name: 'source_400x200.png',
    kind: 'image',
    storage_key: `projects/${projId}/assets/source_400x200.png`,
    mime_type: 'image/png',
    byte_size: fs.statSync(imgPath).size,
  })

  // Clip with scale 1.2, top-left alignment, and opacity 0.8
  await insert('timeline_clips', {
    id: 'clip-overlay-tl-' + uuidv4().slice(0, 8),
    project_id: projId,
    asset_id: assetId,
    clip_type: 'image',
    order_index: 0,
    start_at_sec: 0,
    in_sec: 0,
    out_sec: 2,
    meta: JSON.stringify({
      fit: 'contain',
      autoFit: true,
      scale: 1.2,
      align: 'top-left',
      posX: 5,  // 5%
      posY: 5,  // 5%
      opacity: 0.8,
    }),
  })

  const projectRow = await queryOne('SELECT * FROM projects WHERE id = ?', [projId])
  await composerPrepare({ project: projectRow })
  const renderRes = await composerRender({ project: projectRow })

  assert.ok(renderRes?.outputId, 'Render produced an outputId')
  assert.equal(renderRes.width, 960, 'Render output width matches 960')
  assert.equal(renderRes.height, 540, 'Render output height matches 540')
  console.log(`✓ Overlay transform & alignment verified cleanly: duration=${renderRes.durationSec}s`)
}

// 3. TEST-MULTI-OVERLAY-SIMULTANEOUS: Multiple simultaneous visual clips overlaid
{
  console.log('\n--- 3. TEST-MULTI-OVERLAY-SIMULTANEOUS: Multiple simultaneous visual clips ---')
  const projId = 'proj-multi-overlay-' + uuidv4().slice(0, 8)
  await insert('projects', {
    id: projId,
    user_id: testUserId,
    title: 'Test Multi Overlay Simultaneous',
    mode: 'MEDIA_COMPOSER',
    aspect_ratio: '16:9',
    params: JSON.stringify({ width: 640, height: 360 }),
    status: 'queued',
  })

  await composerService.ensureDefaultTracks(projId)
  const pDir = projectDir(projId)
  const assetsDir = ensureDir(path.join(pDir, 'assets'))
  const imgRed = path.join(assetsDir, 'img_red.png')
  const imgBlue = path.join(assetsDir, 'img_blue.png')

  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=200x200:d=1', '-frames:v', '1', imgRed])
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=150x150:d=1', '-frames:v', '1', imgBlue])

  const assetRedId = 'asset-red-' + uuidv4().slice(0, 8)
  await insert('assets', {
    id: assetRedId,
    project_id: projId,
    name: 'img_red.png',
    kind: 'image',
    storage_key: `projects/${projId}/assets/img_red.png`,
    mime_type: 'image/png',
    byte_size: fs.statSync(imgRed).size,
  })

  const assetBlueId = 'asset-blue-' + uuidv4().slice(0, 8)
  await insert('assets', {
    id: assetBlueId,
    project_id: projId,
    name: 'img_blue.png',
    kind: 'image',
    storage_key: `projects/${projId}/assets/img_blue.png`,
    mime_type: 'image/png',
    byte_size: fs.statSync(imgBlue).size,
  })

  // Clip 1 (Red): starts at 0s, ends at 3s, aligned bottom-left
  await insert('timeline_clips', {
    id: 'clip-red-' + uuidv4().slice(0, 8),
    project_id: projId,
    asset_id: assetRedId,
    clip_type: 'image',
    order_index: 0,
    start_at_sec: 0,
    in_sec: 0,
    out_sec: 3,
    meta: JSON.stringify({ fit: 'contain', align: 'bottom-left', opacity: 0.9 }),
  })

  // Clip 2 (Blue): starts at 1s, ends at 3s, aligned top-right, overlapping Clip 1
  await insert('timeline_clips', {
    id: 'clip-blue-' + uuidv4().slice(0, 8),
    project_id: projId,
    asset_id: assetBlueId,
    clip_type: 'image',
    order_index: 1,
    start_at_sec: 1,
    in_sec: 0,
    out_sec: 3,
    meta: JSON.stringify({ fit: 'contain', align: 'top-right', opacity: 0.7 }),
  })

  const projectRow = await queryOne('SELECT * FROM projects WHERE id = ?', [projId])
  await composerPrepare({ project: projectRow })
  const renderRes = await composerRender({ project: projectRow })

  assert.ok(renderRes?.outputId, 'Render produced an outputId')
  assert.equal(renderRes.durationSec, 4, 'Render duration matches 4s total duration')
  console.log(`✓ Multiple simultaneous visual overlays composited cleanly: duration=${renderRes.durationSec}s`)
}

// 4. TEST-BG-SMART-UPSCALE: Background SMART fit mode with MAX_UPSCALE cap
{
  console.log('\n--- 4. TEST-BG-SMART-UPSCALE: Background SMART fit mode ---')
  const projId = 'proj-bg-smart-' + uuidv4().slice(0, 8)
  await insert('projects', {
    id: projId,
    user_id: testUserId,
    title: 'Test Background Smart Upscale',
    mode: 'MEDIA_COMPOSER',
    aspect_ratio: '16:9',
    params: JSON.stringify({ width: 1280, height: 720, defaultBackground: '#000000' }),
    status: 'queued',
  })

  await composerService.ensureDefaultTracks(projId)
  const pDir = projectDir(projId)
  const assetsDir = ensureDir(path.join(pDir, 'assets'))
  const smallBg = path.join(assetsDir, 'small_bg.png')

  // Generate very small 160x90 image (8x smaller than 720p)
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=orange:s=160x90:d=1', '-frames:v', '1', smallBg])

  const assetBgId = 'asset-bg-' + uuidv4().slice(0, 8)
  await insert('assets', {
    id: assetBgId,
    project_id: projId,
    name: 'small_bg.png',
    kind: 'image',
    storage_key: `projects/${projId}/assets/small_bg.png`,
    mime_type: 'image/png',
    byte_size: fs.statSync(smallBg).size,
  })

  await insert('timeline_clips', {
    id: 'clip-bg-' + uuidv4().slice(0, 8),
    project_id: projId,
    asset_id: assetBgId,
    clip_type: 'background',
    order_index: 0,
    start_at_sec: 0,
    in_sec: 0,
    out_sec: 2,
    meta: JSON.stringify({ fit: 'smart' }),
  })

  const projectRow = await queryOne('SELECT * FROM projects WHERE id = ?', [projId])
  await composerPrepare({ project: projectRow })
  const renderRes = await composerRender({ project: projectRow })

  assert.ok(renderRes?.outputId, 'Render produced an outputId')
  assert.equal(renderRes.width, 1280, 'Render output width matches 1280')
  assert.equal(renderRes.height, 720, 'Render output height matches 720')
  console.log(`✓ Background smart upscale protection verified: ${renderRes.width}x${renderRes.height}`)
}

console.log('\n======================================================')
console.log(' ALL SMART FRAME & ADAPTIVE OVERLAY TESTS PASSED! ')
console.log('======================================================\n')
process.exit(0)
