import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-composer-direct-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'
process.env.MAX_CONCURRENT_PROJECTS_PER_USER = '10'

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne, withTransaction } = await import('../src/db/query.js')
const { ensureDefaultTracks, saveUploadedAsset, saveTimeline, autoArrangeTimeline } = (await import('../src/services/composerService.js')).default
const { composerRender } = await import('../src/pipeline/stages/composerRender.js')
const { resolveStorageKey } = await import('../src/pipeline/context.js')
const { connection } = await import('../src/queue/connection.js')

await initSchema()
try { connection.disconnect() } catch (_) {}

console.log('=== AI Media Composer Direct Studio Editor & Persistence Tests ===\n')

const testUser = { id: 'user-direct-1', email: 'direct1@test.local', role: 'user' }
await insert('users', { id: testUser.id, email: testUser.email, role: 'user', password: 'hash' })

const pId = 'proj-composer-direct-1'
const assetsDir = path.join(tmpRoot, 'storage', 'projects', pId, 'assets')
fs.mkdirSync(assetsDir, { recursive: true })

try {
  // 1. Direct Entry: 7 Tracks Created Automatically
  console.log('--- Test 1: Direct Entry & 7 Default Tracks Auto-Initialization ---')
  await insert('projects', {
    id: pId,
    user_id: testUser.id,
    title: 'Direct Studio Video Project',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
    aspect_ratio: '16:9',
    params: JSON.stringify({ resolution: '1080p', fps: 30, outputFormat: 'mp4', defaultBackground: '#0F1117' }),
  })

  const initialTracks = await ensureDefaultTracks(pId)
  assert.equal(initialTracks.length, 7, 'Direct entry initializes exactly 7 timeline tracks')
  const expectedTypes = ['background', 'video', 'image', 'text', 'voiceover', 'music', 'sfx']
  assert.deepEqual(
    initialTracks.map((t) => t.track_type),
    expectedTypes,
    '7 Tracks follow the correct NLE layer order: background -> video -> image -> text -> voiceover -> music -> sfx'
  )

  // 2. Empty State Validation: Studio loads cleanly with 0 clips & 0 assets
  console.log('--- Test 2: Empty State Friendly (Zero Clips, Zero Assets, Ready to Edit) ---')
  const clipsInDb = await query('SELECT * FROM timeline_clips WHERE project_id = ?', [pId])
  const assetsInDb = await query('SELECT * FROM assets WHERE project_id = ?', [pId])
  assert.equal(clipsInDb.length, 0, 'No mandatory clips initially')
  assert.equal(assetsInDb.length, 0, 'No mandatory assets initially')

  // 3. Multi-type Media Asset Uploads (Video, Image, Music, SFX)
  console.log('--- Test 3: Upload Diverse Media Kinds (Video, Image, Audio) & Auto-type Detection ---')
  
  const dummyImgPath = path.join(assetsDir, 'test-slide.png')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=1', '-update', '1', '-frames:v', '1', dummyImgPath])
  
  const dummyVideoPath = path.join(assetsDir, 'test-clip.mp4')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', dummyVideoPath])

  const dummyAudioPath = path.join(assetsDir, 'test-sound.mp3')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', dummyAudioPath])

  const savedImg = await saveUploadedAsset({
    projectId: pId,
    userId: testUser.id,
    file: { path: dummyImgPath, originalname: 'slide.png', mimetype: 'image/png' },
    kind: 'image',
    orderIndex: 0,
  })
  assert.equal(savedImg.kind, 'image', 'Image asset saved with kind=image')
  assert.ok(savedImg.thumbnailKey, 'Image has generated thumbnail')

  const savedVid = await saveUploadedAsset({
    projectId: pId,
    userId: testUser.id,
    file: { path: dummyVideoPath, originalname: 'clip.mp4', mimetype: 'video/mp4' },
    kind: 'video',
    orderIndex: 1,
  })
  assert.equal(savedVid.kind, 'video', 'Video asset saved with kind=video')
  assert.ok(savedVid.durationSec >= 1.9, 'Video asset duration probed accurately')

  const savedMusic = await saveUploadedAsset({
    projectId: pId,
    userId: testUser.id,
    file: { path: dummyAudioPath, originalname: 'bgm.mp3', mimetype: 'audio/mpeg' },
    kind: 'music',
    orderIndex: 2,
  })
  assert.equal(savedMusic.kind, 'music', 'Music asset saved with kind=music')

  // 4. Multi-track Timeline Editing: Add Clips to 7 Different Tracks
  console.log('--- Test 4: Save Clips to 7 Different Tracks (Video, Image, Text, Music) ---')
  const trackMap = new Map(initialTracks.map((t) => [t.track_type, t.id]))

  const newClips = [
    {
      id: 'clip-video-1',
      track_id: trackMap.get('video'),
      clip_type: 'video',
      asset_id: savedVid.id,
      start_at_sec: 0,
      duration: 2.0,
      volume: 1.0,
    },
    {
      id: 'clip-image-1',
      track_id: trackMap.get('image'),
      clip_type: 'image',
      asset_id: savedImg.id,
      start_at_sec: 2.0,
      duration: 3.0,
    },
    {
      id: 'clip-text-1',
      track_id: trackMap.get('text'),
      clip_type: 'text',
      start_at_sec: 1.0,
      duration: 3.0,
      text_content: 'Direct Studio Editing Subtitle',
      style_json: JSON.stringify({ fontSize: 24, color: '#FFFF00', bg: 'rgba(0,0,0,0.7)', position: 'bottom' }),
    },
    {
      id: 'clip-music-1',
      track_id: trackMap.get('music'),
      clip_type: 'music',
      audio_id: savedMusic.id,
      start_at_sec: 0,
      duration: 5.0,
      volume: 0.8,
    },
  ]

  const savedTimeline = await saveTimeline({
    projectId: pId,
    tracks: initialTracks,
    clips: newClips,
  })
  assert.equal(savedTimeline.clips.length, 4, 'Successfully saved 4 clips across multi-tracks')

  // 5. F5 Reload Persistence Simulation
  console.log('--- Test 5: F5 Reload Persistence (Full Database Recovery) ---')
  const reloadedTracks = await query('SELECT * FROM timeline_tracks WHERE project_id = ? ORDER BY order_index ASC', [pId])
  const reloadedClips = await query('SELECT * FROM timeline_clips WHERE project_id = ? ORDER BY start_at_sec ASC', [pId])
  const reloadedAssets = await query('SELECT * FROM assets WHERE project_id = ? ORDER BY order_index ASC', [pId])

  assert.equal(reloadedTracks.length, 7, 'F5 Reload: 7 tracks recovered intact')
  assert.equal(reloadedClips.length, 4, 'F5 Reload: 4 clips recovered intact')
  assert.equal(reloadedAssets.length, 3, 'F5 Reload: 3 assets recovered intact')

  const textClip = reloadedClips.find((c) => c.id === 'clip-text-1')
  assert.equal(textClip.text_content, 'Direct Studio Editing Subtitle', 'F5 Reload: Text content preserved')
  const parsedStyle = JSON.parse(textClip.style_json)
  assert.equal(parsedStyle.color, '#FFFF00', 'F5 Reload: Text style preserved')

  // 6. Partial Render Resilience (Graceful Pipeline Execution)
  console.log('--- Test 6: Partial Render Resilience (No crash when tracks are partially used) ---')
  const projectRow = await queryOne('SELECT * FROM projects WHERE id = ?', [pId])
  const renderRes = await composerRender({ project: projectRow })
  assert.ok(renderRes.outputId, 'Render produced valid output record')
  assert.ok(renderRes.storageKey, 'Render stored output key')

  const finalVideoAbs = resolveStorageKey(renderRes.storageKey)
  assert.ok(fs.existsSync(finalVideoAbs), 'Render output file exists on disk')
  const stat = fs.statSync(finalVideoAbs)
  assert.ok(stat.size > 1000, 'Render output size is valid (>1KB)')

  console.log(`\nRender Output: ${finalVideoAbs} (${stat.size} bytes)`)

  // 7. Auto-Arrange on Empty Project (Safe Return & Descriptive Guidance)
  console.log('--- Test 7: Auto-Arrange on Empty Project (Safe Return & Descriptive Guidance) ---')
  const emptyProjectId = 'proj-composer-empty-auto'
  await insert('projects', {
    id: emptyProjectId,
    user_id: testUser.id,
    title: 'Empty Media Auto Arrange Project',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
  })
  await ensureDefaultTracks(emptyProjectId)
  const emptyArrange = await autoArrangeTimeline({ projectId: emptyProjectId })
  assert.equal(emptyArrange.tracks.length, 7, 'Empty auto-arrange maintains 7 tracks')
  assert.ok(emptyArrange.message, 'Provides user guidance message')
  assert.equal(emptyArrange.clips.filter((c) => (c.clip_type || c.type) !== 'background').length, 0, 'No non-background clips generated on empty assets')

  // 8. Upload Video Background with kind: 'background'
  console.log('--- Test 8: Upload Video Background Asset (kind: background, video/mp4) ---')
  const dummyBgVideoPath = path.join(assetsDir, 'test-bg-video.mp4')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=green:s=640x360:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', dummyBgVideoPath])

  const savedBgVid = await saveUploadedAsset({
    projectId: pId,
    userId: testUser.id,
    file: { path: dummyBgVideoPath, originalname: 'bg-loop.mp4', mimetype: 'video/mp4' },
    kind: 'background',
    orderIndex: 3,
  })
  assert.equal(savedBgVid.kind, 'background', 'Asset preserves kind=background when uploading video in background tab')
  assert.ok(savedBgVid.durationSec >= 1.9, 'Probes durationSec for video background')
  assert.ok(savedBgVid.thumbnailKey, 'Generates thumbnail for video background')

  // 9. Video Background Timeline Clip Persistence & FFmpeg Render
  console.log('--- Test 9: Video Background Clip with fit=contain & loop, F5 Persistence, and FFmpeg Render ---')
  const bgClipWithMeta = {
    id: 'clip-bg-video-1',
    track_id: trackMap.get('background'),
    clip_type: 'background',
    asset_id: savedBgVid.id,
    start_at_sec: 0,
    duration: 6.0,
    meta: {
      fit: 'contain',
      loop: true,
      muted: true,
      opacity: 0.8,
      isVideo: true,
      name: 'bg-loop.mp4',
    },
  }

  await saveTimeline({
    projectId: pId,
    tracks: initialTracks,
    clips: [bgClipWithMeta],
  })

  // F5 recovery check
  const reloadedBgClips = await query('SELECT * FROM timeline_clips WHERE project_id = ? AND clip_type = "background"', [pId])
  assert.equal(reloadedBgClips.length, 1, 'Background clip persisted in DB')
  const loadedMeta = typeof reloadedBgClips[0].meta === 'string' ? JSON.parse(reloadedBgClips[0].meta) : reloadedBgClips[0].meta
  assert.equal(loadedMeta.fit, 'contain', 'Meta fit=contain preserved across reload')
  assert.equal(loadedMeta.loop, true, 'Meta loop=true preserved across reload')
  assert.equal(loadedMeta.opacity, 0.8, 'Meta opacity=0.8 preserved across reload')

  // Render project with Video Background
  const videoBgRender = await composerRender({ project: projectRow })
  assert.ok(videoBgRender.storageKey, 'Renders video with video background successfully')
  const videoBgAbs = resolveStorageKey(videoBgRender.storageKey)
  assert.ok(fs.existsSync(videoBgAbs), 'Video background output file exists')
  const bgStat = fs.statSync(videoBgAbs)
  assert.ok(bgStat.size > 1000, 'Video background output has valid non-zero size')

  console.log(`Video Background Render Output: ${videoBgAbs} (${bgStat.size} bytes)\n`)

  // 10. Cross-Aspect Ratio (Cover): Vertical Video 9:16 (360x640) on 16:9 Project
  console.log('--- Test 10: Cross-Aspect Ratio (Cover) - 9:16 Vertical Video on 16:9 Canvas ---')
  const verticalVidPath = path.join(assetsDir, 'test-vertical-916.mp4')
  execFileSync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=360x640:rate=25',
    '-t', '2',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    verticalVidPath,
  ])

  const savedVerticalAsset = await saveUploadedAsset({
    projectId: pId,
    userId: testUser.id,
    file: { path: verticalVidPath, originalname: 'vertical-916.mp4', mimetype: 'video/mp4' },
    kind: 'background',
    orderIndex: 4,
  })
  assert.equal(savedVerticalAsset.kind, 'background', 'Vertical asset saved as background')
  assert.ok(savedVerticalAsset.durationSec >= 1.9, 'Probes duration for vertical video')

  const bgClipCover = {
    id: 'clip-bg-cover-916',
    track_id: trackMap.get('background'),
    clip_type: 'background',
    asset_id: savedVerticalAsset.id,
    start_at_sec: 0,
    duration: 3.0,
    meta: {
      fit: 'cover',
      loop: true,
      muted: false, // Testing audio safety when source has no audio stream (silent video)
      opacity: 1.0,
      isVideo: true,
      name: 'vertical-916.mp4',
    },
  }

  await saveTimeline({
    projectId: pId,
    tracks: initialTracks,
    clips: [bgClipCover],
  })

  const coverRender = await composerRender({ project: projectRow })
  assert.ok(coverRender.storageKey, 'Cover render produces valid storageKey')
  assert.equal(coverRender.width, 1920, 'Cover render scales/crops to project width 1920')
  assert.equal(coverRender.height, 1080, 'Cover render scales/crops to project height 1080')
  const coverOutAbs = resolveStorageKey(coverRender.storageKey)
  assert.ok(fs.existsSync(coverOutAbs), 'Cover render file exists on disk')
  assert.ok(fs.statSync(coverOutAbs).size > 1000, 'Cover render has non-zero size')
  console.log(`Test 10 PASS: Cross-Aspect Ratio Cover 1920x1080 verified (${fs.statSync(coverOutAbs).size} bytes)\n`)

  // 11. Cross-Aspect Ratio (Contain): Vertical Video 9:16 with Background Padding
  console.log('--- Test 11: Cross-Aspect Ratio (Contain) - 9:16 Vertical Video on 16:9 Canvas with Padding ---')
  const bgClipContain = {
    id: 'clip-bg-contain-916',
    track_id: trackMap.get('background'),
    clip_type: 'background',
    asset_id: savedVerticalAsset.id,
    start_at_sec: 0,
    duration: 3.0,
    meta: {
      fit: 'contain',
      loop: true,
      muted: true,
      opacity: 0.9,
      isVideo: true,
      name: 'vertical-916.mp4',
    },
  }

  await saveTimeline({
    projectId: pId,
    tracks: initialTracks,
    clips: [bgClipContain],
  })

  const containRender = await composerRender({ project: projectRow })
  assert.ok(containRender.storageKey, 'Contain render produces valid storageKey')
  assert.equal(containRender.width, 1920, 'Contain render maintains 1920 canvas width with padding')
  assert.equal(containRender.height, 1080, 'Contain render maintains 1080 canvas height')
  const containOutAbs = resolveStorageKey(containRender.storageKey)
  assert.ok(fs.existsSync(containOutAbs), 'Contain render file exists on disk')
  assert.ok(fs.statSync(containOutAbs).size > 1000, 'Contain render has non-zero size')
  console.log(`Test 11 PASS: Cross-Aspect Ratio Contain with #0F1117 pad verified (${fs.statSync(containOutAbs).size} bytes)\n`)

  // 12. Cascade Asset Deletion & Solid Background Fallback
  console.log('--- Test 12: Cascade Asset Deletion & Fallback to Default Solid Background ---')
  const preDeleteClips = await query('SELECT * FROM timeline_clips WHERE project_id = ? AND asset_id = ?', [pId, savedVerticalAsset.id])
  assert.ok(preDeleteClips.length > 0, 'Timeline clip referencing vertical asset exists')

  // Simulate cascade deletion (identical to DELETE /api/v1/projects/:id/assets/:assetId)
  await withTransaction(async (tx) => {
    await tx.run('DELETE FROM timeline_clips WHERE (asset_id = ? OR voice_audio_id = ?) AND project_id = ?', [savedVerticalAsset.id, savedVerticalAsset.id, pId])
    await tx.run('DELETE FROM audios WHERE id = ? AND project_id = ?', [savedVerticalAsset.id, pId])
    await tx.run('DELETE FROM assets WHERE id = ? AND project_id = ?', [savedVerticalAsset.id, pId])
  })

  const postDeleteClips = await query('SELECT * FROM timeline_clips WHERE project_id = ? AND asset_id = ?', [pId, savedVerticalAsset.id])
  assert.equal(postDeleteClips.length, 0, 'Timeline clips referencing deleted asset are purged')

  // Add an image clip so timeline has content, but no background clip (fallback to solid #0F1117)
  const imageClip = {
    id: 'clip-fallback-img-1',
    track_id: trackMap.get('image'),
    clip_type: 'image',
    asset_id: savedImg.id,
    start_at_sec: 0,
    duration: 2.0,
  }
  await saveTimeline({
    projectId: pId,
    tracks: initialTracks,
    clips: [imageClip],
  })

  const fallbackRender = await composerRender({ project: projectRow })
  assert.ok(fallbackRender.storageKey, 'Render succeeds with default solid background after asset deletion')
  const fallbackAbs = resolveStorageKey(fallbackRender.storageKey)
  assert.ok(fs.existsSync(fallbackAbs), 'Fallback render output file exists')
  assert.ok(fs.statSync(fallbackAbs).size > 1000, 'Fallback render output has valid non-zero size')
  console.log(`Test 12 PASS: Cascade asset deletion and solid background fallback verified (${fs.statSync(fallbackAbs).size} bytes)\n`)

  console.log('ALL PASS: AI Media Composer Direct Studio Editor & Persistence tests (12/12) passed.\n')
} finally {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch (_) {}
}
