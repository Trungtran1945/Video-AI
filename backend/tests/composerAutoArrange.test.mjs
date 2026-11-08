import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_composer_arrange_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne } = await import('../src/db/query.js')
const {
  ensureDefaultTracks,
  autoArrangeTimeline,
  saveTimeline,
} = await import('../src/services/composerService.js')

await initSchema()

console.log('=== AI Media Composer Auto-Arrange & Timeline Tests ===\n')

const testUserId = 'user-composer-arrange-1'
await insert('users', {
  id: testUserId,
  email: 'composer-arrange@test.local',
  role: 'user',
  password: 'hash',
})

// 1. ensureDefaultTracks test
{
  console.log('--- 1. ensureDefaultTracks idempotent track initialization ---')
  const projectId = 'proj-arrange-1'
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    title: 'Test Composer 1',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
  })

  const tracks1 = await ensureDefaultTracks(projectId)
  assert.equal(tracks1.length, 5, 'Creates exactly 5 default tracks')
  const trackTypes = tracks1.map((t) => t.track_type)
  assert.deepEqual(trackTypes, ['background', 'image', 'voiceover', 'music', 'text'], 'Default tracks order')

  // Repeat call must not duplicate tracks
  const tracks2 = await ensureDefaultTracks(projectId)
  assert.equal(tracks2.length, 5, 'Idempotent: does not duplicate tracks')
}

// 2. autoArrangeTimeline with only images
{
  console.log('--- 2. autoArrangeTimeline with only image assets ---')
  const projectId = 'proj-arrange-2'
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    title: 'Test Composer 2',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
  })
  await ensureDefaultTracks(projectId)

  // Insert 3 image assets
  for (let i = 1; i <= 3; i++) {
    await insert('assets', {
      id: `asset-img-${i}`,
      project_id: projectId,
      user_id: testUserId,
      kind: 'image',
      name: `Slide ${i}.jpg`,
      storage_key: `projects/${projectId}/assets/slide_${i}.jpg`,
      order_index: i - 1,
    })
  }

  const result = await autoArrangeTimeline({
    projectId,
    imageDurationSec: 4.0,
    enableBgmDucking: true,
  })

  assert.equal(result.totalDuration, 12, 'Total duration is 3 * 4s = 12s')
  // Clips: 1 background + 3 images = 4 clips
  const imgClips = result.clips.filter((c) => c.clip_type === 'image')
  const bgClips = result.clips.filter((c) => c.clip_type === 'background')

  assert.equal(imgClips.length, 3, 'Created 3 image clips')
  assert.equal(bgClips.length, 1, 'Created 1 background clip')
  assert.equal(bgClips[0].out_sec, 12, 'Background clip spans total duration 12s')

  assert.equal(imgClips[0].start_at_sec, 0, 'First image starts at 0s')
  assert.equal(imgClips[0].out_sec, 4, 'First image duration is 4s')
  assert.equal(imgClips[1].start_at_sec, 4, 'Second image starts at 4s')
  assert.equal(imgClips[2].start_at_sec, 8, 'Third image starts at 8s')
}

// 3. autoArrangeTimeline with voiceover & BGM ducking
{
  console.log('--- 3. autoArrangeTimeline with voiceover and ducking ---')
  const projectId = 'proj-arrange-3'
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    title: 'Test Composer 3',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
  })
  await ensureDefaultTracks(projectId)

  // 2 image assets
  await insert('assets', {
    id: 'asset-img-3-1',
    project_id: projectId,
    user_id: testUserId,
    kind: 'image',
    name: 'Photo 1.jpg',
    storage_key: `projects/${projectId}/assets/p1.jpg`,
    order_index: 0,
  })
  await insert('assets', {
    id: 'asset-img-3-2',
    project_id: projectId,
    user_id: testUserId,
    kind: 'image',
    name: 'Photo 2.jpg',
    storage_key: `projects/${projectId}/assets/p2.jpg`,
    order_index: 1,
  })

  // 1 voiceover asset with 10s duration
  await insert('assets', {
    id: 'asset-vo-1',
    project_id: projectId,
    user_id: testUserId,
    kind: 'voiceover',
    name: 'Voiceover.mp3',
    storage_key: `projects/${projectId}/assets/vo.mp3`,
    duration_sec: 10.0,
    meta: JSON.stringify({ isVoiceover: true }),
    order_index: 0,
  })

  // 1 music asset
  await insert('assets', {
    id: 'asset-bgm-1',
    project_id: projectId,
    user_id: testUserId,
    kind: 'music',
    name: 'Bgm.mp3',
    storage_key: `projects/${projectId}/assets/bgm.mp3`,
    duration_sec: 30.0,
    order_index: 0,
  })

  const result = await autoArrangeTimeline({
    projectId,
    imageDurationSec: 4.0,
    enableBgmDucking: true,
  })

  assert.equal(result.totalDuration, 10, 'Total duration matches voiceover 10s')
  const imgClips = result.clips.filter((c) => c.clip_type === 'image')
  assert.equal(imgClips.length, 2, '2 image clips')
  assert.equal(imgClips[0].out_sec, 5, 'First image scaled to 5s')
  assert.equal(imgClips[1].out_sec, 5, 'Second image scaled to 5s')

  const musicClips = result.clips.filter((c) => c.clip_type === 'music')
  assert.equal(musicClips.length, 1, 'Music clip created')
  assert.equal(musicClips[0].volume, 0.25, 'Music ducked to 0.25 volume due to voiceover')
}

// 4. saveTimeline persistence test
{
  console.log('--- 4. saveTimeline updates tracks and clips in DB ---')
  const projectId = 'proj-arrange-4'
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    title: 'Test Composer 4',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
  })
  const tracks = await ensureDefaultTracks(projectId)
  const imageTrack = tracks.find((t) => t.track_type === 'image')

  await saveTimeline({
    projectId,
    tracks: [
      { id: imageTrack.id, muted: true, volume: 0.8, locked: true, name: 'Main Visuals' },
    ],
    clips: [
      {
        id: 'clip-manual-1',
        track_id: imageTrack.id,
        clip_type: 'image',
        start_at_sec: 1.5,
        out_sec: 6.5,
        volume: 1.0,
      },
    ],
  })

  // Verify updated track
  const updatedTrack = await queryOne('SELECT * FROM timeline_tracks WHERE id = ?', [imageTrack.id])
  assert.equal(updatedTrack.muted, 1, 'Track is muted')
  assert.equal(updatedTrack.locked, 1, 'Track is locked')
  assert.equal(updatedTrack.name, 'Main Visuals', 'Track name updated')

  // Verify updated clip
  const clips = await query('SELECT * FROM timeline_clips WHERE project_id = ?', [projectId])
  assert.equal(clips.length, 1, 'Saved 1 clip')
  assert.equal(clips[0].start_at_sec, 1.5, 'Clip start preserved')
  assert.equal(clips[0].out_sec, 6.5, 'Clip duration preserved')
}

// 5. autoArrangeTimeline with 0 assets (empty edge case)
{
  console.log('--- 5. autoArrangeTimeline with 0 assets ---')
  const projectId = 'proj-arrange-empty'
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    title: 'Test Composer Empty',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
  })

  const result = await autoArrangeTimeline({ projectId })
  assert.equal(result.totalDuration, 10, 'Defaults to 10s duration when no assets')
  assert.equal(result.clips.length, 1, 'Generates 1 background clip')
  assert.equal(result.clips[0].clip_type, 'background', 'Clip is of type background')
  assert.equal(result.clips[0].out_sec, 10, 'Background clip covers 10s')
}

// 6. autoArrangeTimeline with 1 single image having OCR text overlay
{
  console.log('--- 6. autoArrangeTimeline with 1 image and OCR overlay ---')
  const projectId = 'proj-arrange-single'
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    title: 'Test Composer Single Image',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
  })
  await insert('assets', {
    id: 'asset-single-1',
    project_id: projectId,
    user_id: testUserId,
    kind: 'image',
    name: 'Hero.png',
    storage_key: `projects/${projectId}/assets/hero.png`,
    translation_text: 'Siêu Giảm Giá Mùa Đông',
    order_index: 0,
  })

  const result = await autoArrangeTimeline({ projectId, imageDurationSec: 6 })
  assert.equal(result.totalDuration, 6, 'Total duration is 6s for single image')
  const textClips = result.clips.filter((c) => c.clip_type === 'text')
  assert.equal(textClips.length, 1, 'Created 1 text overlay clip from OCR translation')
  assert.equal(textClips[0].text_content, 'Siêu Giảm Giá Mùa Đông', 'Text overlay has correct content')
  assert.equal(textClips[0].start_at_sec, 0, 'Text overlay starts at 0s')
  assert.equal(textClips[0].out_sec, 6, 'Text overlay duration is 6s')
}

console.log('\nALL PASS: AI Media Composer Auto-Arrange & Timeline tests passed.')

process.exit(0)
