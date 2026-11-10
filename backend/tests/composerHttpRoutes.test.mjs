import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { once } from 'node:events'
import assert from 'node:assert/strict'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-composer-http-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'
process.env.MAX_CONCURRENT_PROJECTS_PER_USER = '10'

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne, run } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const projectsMod = await import('../src/routes/v1/projects.js')
const projectsRouter = projectsMod.default
const composerAssetsRouter = (await import('../src/routes/v1/composerAssets.js')).default
const { connection } = await import('../src/queue/connection.js')

await initSchema()
try { connection.disconnect() } catch (_) {}

console.log('=== AI Media Composer HTTP API & Route Contract Tests ===\n')

const testUser1 = { id: 'user-comp-http-1', email: 'comp-http-1@test.local', role: 'user' }
const testUser2 = { id: 'user-comp-http-2', email: 'comp-http-2@test.local', role: 'user' }

await insert('users', { id: testUser1.id, email: testUser1.email, role: 'user', password: 'hash' })
await insert('users', { id: testUser2.id, email: testUser2.email, role: 'user', password: 'hash' })

const token1 = generateAccessToken(testUser1)
const token2 = generateAccessToken(testUser2)

const app = express()
app.use(express.json())
app.use('/api/v1/projects', projectsRouter)
app.use('/api/v1/projects', composerAssetsRouter)

const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/api/v1/projects`

try {
  // 1. POST /api/v1/projects with MEDIA_COMPOSER
  console.log('--- 1. POST /projects initializes MEDIA_COMPOSER with 5 tracks ---')
  const createRes = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token1}`,
    },
    body: JSON.stringify({
      mode: 'MEDIA_COMPOSER',
      title: 'Composer E2E Video Project',
      aspectRatio: '16:9',
      copyrightAcknowledged: true,
      params: {
        resolution: '1080p',
        fps: 30,
      },
    }),
  })

  assert.equal(createRes.status, 202, 'Returns HTTP 202 Created')
  const createdProject = await createRes.json()
  assert.equal(createdProject.mode, 'MEDIA_COMPOSER', 'Project mode is MEDIA_COMPOSER')
  assert.equal(createdProject.title, 'Composer E2E Video Project', 'Project title matches')
  const projectId = createdProject.id

  // Verify tracks created in DB
  const tracks = await query('SELECT * FROM timeline_tracks WHERE project_id = ? ORDER BY order_index ASC', [projectId])
  assert.equal(tracks.length, 7, 'Creates 7 tracks: background, video, image, text, voiceover, music, sfx')
  assert.deepEqual(tracks.map((t) => t.track_type), ['background', 'video', 'image', 'text', 'voiceover', 'music', 'sfx'])

  // 2. GET /api/v1/projects/:id returns extras.tracks and extras.assets
  console.log('--- 2. GET /projects/:id returns extras.tracks and extras.assets ---')
  const getRes = await fetch(`${baseUrl}/${projectId}`, {
    headers: { Authorization: `Bearer ${token1}` },
  })
  assert.equal(getRes.status, 200, 'Returns HTTP 200')
  const projectDetail = await getRes.json()
  assert.ok(Array.isArray(projectDetail.tracks), 'Exposes tracks array')
  assert.equal(projectDetail.tracks.length, 7, 'Exposes 7 tracks')
  assert.ok(Array.isArray(projectDetail.assets), 'Exposes assets array')

  // 3. Permission checks (User 2 cannot access User 1 project)
  console.log('--- 3. Permission check: foreign user gets 403 ---')
  const forbiddenRes = await fetch(`${baseUrl}/${projectId}`, {
    headers: { Authorization: `Bearer ${token2}` },
  })
  assert.equal(forbiddenRes.status, 403, 'User 2 receives HTTP 403 on project detail')

  // 4. PUT /api/v1/projects/:id/timeline saves tracks and clips
  console.log('--- 4. PUT /projects/:id/timeline updates tracks and clips ---')
  const imageTrack = tracks.find((t) => t.track_type === 'image')
  const putTimelineRes = await fetch(`${baseUrl}/${projectId}/timeline`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token1}`,
    },
    body: JSON.stringify({
      tracks: [
        { id: imageTrack.id, name: 'Custom Visuals', volume: 0.9, muted: true, locked: false },
      ],
      clips: [
        {
          id: 'clip-test-e2e-1',
          trackId: imageTrack.id,
          clip_type: 'image',
          start_at_sec: 2.0,
          out_sec: 5.0,
        },
      ],
    }),
  })
  assert.equal(putTimelineRes.status, 200, 'PUT /timeline returns 200')
  const putData = await putTimelineRes.json()
  assert.equal(putData.clips.length, 1, 'Returns 1 saved clip')
  assert.equal(putData.clips[0].start_at_sec, 2.0, 'Clip start_at_sec persisted')

  // 5. POST /api/v1/projects/:id/auto-arrange
  console.log('--- 5. POST /projects/:id/auto-arrange updates timeline ---')
  // Insert an image asset
  await insert('assets', {
    id: 'asset-http-img-1',
    project_id: projectId,
    user_id: testUser1.id,
    kind: 'image',
    name: 'photo1.jpg',
    storage_key: `projects/${projectId}/assets/p1.jpg`,
    order_index: 0,
  })

  const autoRes = await fetch(`${baseUrl}/${projectId}/auto-arrange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token1}`,
    },
    body: JSON.stringify({
      imageDurationSec: 5,
      loopBgm: true,
      enableDucking: true,
    }),
  })
  assert.equal(autoRes.status, 200, 'POST /auto-arrange returns 200')
  const autoData = await autoRes.json()
  assert.equal(autoData.totalDuration, 5, 'Total duration calculated from single image')
  assert.ok(autoData.clips.some((c) => c.clip_type === 'image'), 'Has image clip')
  assert.ok(autoData.clips.some((c) => c.clip_type === 'background'), 'Has background clip')

  // 6. DELETE /api/v1/projects/:id/assets/:assetId deletes asset & cascading clips
  console.log('--- 6. DELETE /projects/:id/assets/:assetId cleans up DB ---')
  const delRes = await fetch(`${baseUrl}/${projectId}/assets/asset-http-img-1`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token1}` },
  })
  assert.equal(delRes.status, 200, 'DELETE asset returns 200')
  const delData = await delRes.json()
  assert.equal(delData.assetId, 'asset-http-img-1', 'Returns deleted assetId')

  const assetCheck = await queryOne('SELECT * FROM assets WHERE id = ?', ['asset-http-img-1'])
  assert.equal(assetCheck, null, 'Asset deleted from database')

  const clipCheck = await queryOne('SELECT * FROM timeline_clips WHERE asset_id = ?', ['asset-http-img-1'])
  assert.equal(clipCheck, null, 'Timeline clips referencing asset deleted without 500 error')

  // 7. Non-owner gets 403 on DELETE asset
  console.log('--- 7. Non-owner gets 403 on DELETE asset ---')
  await insert('assets', {
    id: 'asset-http-img-2',
    project_id: projectId,
    user_id: testUser1.id,
    kind: 'image',
    name: 'photo2.jpg',
    storage_key: `projects/${projectId}/assets/p2.jpg`,
    order_index: 0,
  })
  const nonOwnerDel = await fetch(`${baseUrl}/${projectId}/assets/asset-http-img-2`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token2}` },
  })
  assert.equal(nonOwnerDel.status, 403, 'Non-owner receives 403')

  // 8. Backward compatibility: SUMMARY mode creation still works
  console.log('--- 8. Backward compatibility: SUMMARY mode project creation ---')
  const summaryRes = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token1}`,
    },
    body: JSON.stringify({
      mode: 'SUMMARY',
      title: 'Legacy Movie Review',
      sourceVideoKey: 'uploads/mock-video.mp4',
      copyrightAcknowledged: true,
    }),
  })
  assert.equal(summaryRes.status, 202, 'SUMMARY project created with 202')
  const summaryProject = await summaryRes.json()
  assert.equal(summaryProject.mode, 'SUMMARY', 'Mode is SUMMARY')

  // 9. PUT /projects/:id/assets/reorder batch updates order_index
  console.log('--- 9. PUT /projects/:id/assets/reorder updates order_index ---')
  const aId1 = 'asset-reorder-1'
  const aId2 = 'asset-reorder-2'
  await insert('assets', {
    id: aId1,
    project_id: projectId,
    user_id: testUser1.id,
    kind: 'image',
    name: 'img1.png',
    storage_key: `projects/${projectId}/assets/img1.png`,
    order_index: 0,
  })
  await insert('assets', {
    id: aId2,
    project_id: projectId,
    user_id: testUser1.id,
    kind: 'image',
    name: 'img2.png',
    storage_key: `projects/${projectId}/assets/img2.png`,
    order_index: 1,
  })

  // Swap order: aId2 first, aId1 second
  const reorderRes = await fetch(`${baseUrl}/${projectId}/assets/reorder`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token1}`,
    },
    body: JSON.stringify({ assetIds: [aId2, aId1] }),
  })
  assert.equal(reorderRes.status, 200, 'PUT /assets/reorder returns 200')
  const reorderData = await reorderRes.json()
  assert.ok(Array.isArray(reorderData.assets), 'Returns assets array')

  const asset1 = await queryOne('SELECT order_index FROM assets WHERE id = ?', [aId1])
  const asset2 = await queryOne('SELECT order_index FROM assets WHERE id = ?', [aId2])
  assert.equal(asset2.order_index, 0, 'asset 2 has order_index 0')
  assert.equal(asset1.order_index, 1, 'asset 1 has order_index 1')

  // 10. Robustness: legacy rows or null created_date does not cause 500
  console.log('--- 10. Legacy assets without created_date query successfully ---')
  const legacyAssetId = 'asset-legacy-1'
  await insert('assets', {
    id: legacyAssetId,
    project_id: projectId,
    user_id: testUser1.id,
    kind: 'image',
    name: 'legacy.png',
    storage_key: `projects/${projectId}/assets/legacy.png`,
    order_index: 2,
    created_date: null,
  })
  const projectGetRes = await fetch(`${baseUrl}/${projectId}`, {
    headers: { Authorization: `Bearer ${token1}` },
  })
  assert.equal(projectGetRes.status, 200, 'GET /projects/:id returns 200 with legacy assets')
  const projectData = await projectGetRes.json()
  assert.ok(projectData.assets.some((a) => a.id === legacyAssetId), 'Contains legacy asset')

  const assetsGetRes = await fetch(`${baseUrl}/${projectId}/assets`, {
    headers: { Authorization: `Bearer ${token1}` },
  })
  assert.equal(assetsGetRes.status, 200, 'GET /projects/:id/assets returns 200')
  const assetsData = await assetsGetRes.json()
  assert.ok(assetsData.assets.some((a) => a.id === legacyAssetId), 'Asset list contains legacy asset')

  // 11. DTO Consistency across GET /projects/:id, GET /assets, and PUT /assets/reorder
  console.log('--- 11. DTO Consistency: url, storageKey, thumbnailUrl, mimeType across endpoints ---')
  for (const asset of projectData.assets) {
    assert.ok(asset.id, 'Asset DTO has id')
    assert.ok(asset.projectId || asset.project_id, 'Asset DTO has projectId')
    assert.ok(asset.storageKey, 'Asset DTO has storageKey (camelCase)')
    assert.ok(asset.storage_key, 'Asset DTO has storage_key (snake_case)')
    assert.ok(asset.url.startsWith('/storage/'), 'Asset DTO has computed url')
  }

  for (const asset of assetsData.assets) {
    assert.ok(asset.id, 'Asset DTO has id')
    assert.ok(asset.projectId || asset.project_id, 'Asset DTO has projectId')
    assert.ok(asset.storageKey, 'Asset DTO has storageKey (camelCase)')
    assert.ok(asset.storage_key, 'Asset DTO has storage_key (snake_case)')
    assert.ok(asset.url.startsWith('/storage/'), 'Asset DTO has computed url')
  }

  for (const asset of reorderData.assets) {
    assert.ok(asset.id, 'Reordered asset DTO has id')
    assert.ok(asset.storageKey, 'Reordered asset DTO has storageKey')
    assert.ok(asset.url.startsWith('/storage/'), 'Reordered asset DTO has computed url')
  }

  console.log('\nALL PASS: AI Media Composer HTTP API & Route Contract tests passed.')
} finally {
  server.close()
}

process.exit(0)
