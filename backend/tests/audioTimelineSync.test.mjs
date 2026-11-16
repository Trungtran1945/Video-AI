import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { v4 as uuidv4 } from 'uuid'

// Set isolated test DB
process.env.DB_PATH = path.join(os.tmpdir(), `vidai_audio_timeline_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne, query } = await import('../src/db/query.js')
const { default: composerService } = await import('../src/services/composerService.js')
const { formatTimeCode, formatRulerTime, getMagneticSnap, getHandleSnap } = await import('../../frontend/src/components/timeline/timelineUtils.js')

await initSchema()

test('formatTimeCode and formatRulerTime format correctly', () => {
  assert.equal(formatTimeCode(0), '00:00:00')
  assert.equal(formatTimeCode(65.5), '01:05:15')
  assert.equal(formatTimeCode(125.1), '02:05:03')
  assert.equal(formatRulerTime(0), '00:00')
  assert.equal(formatRulerTime(65), '01:05')
})

test('getMagneticSnap and getHandleSnap snap within threshold', () => {
  const allClips = [
    { id: 'clip-1', start: 0, duration: 4 },
    { id: 'clip-2', start: 6, duration: 5 },
  ]
  const snapRes = getMagneticSnap({
    candidateStart: 4.08,
    duration: 2,
    allClips,
    currentClipId: 'clip-moving',
    currentTime: 10,
    zoomLevel: 50,
    thresholdPx: 10,
  })
  assert.equal(snapRes.snappedStart, 4.0)

  const handleRes = getHandleSnap({
    targetEdge: 3.95,
    allClips,
    currentClipId: 'clip-moving',
    currentTime: 2,
    zoomLevel: 50,
    thresholdPx: 10,
  })
  assert.equal(handleRes.snappedEdge, 4.0)
})

test('composerService.saveTimeline: recalculates out_sec from duration and preserves audio IDs', async () => {
  const userId = 'u-test-' + uuidv4().slice(0, 8)
  const projId = 'proj-timeline-' + uuidv4().slice(0, 8)

  await insert('users', {
    id: userId,
    email: `timeline-test-${Date.now()}@test.local`,
    role: 'user',
    password: 'hash',
  })

  await insert('projects', {
    id: projId,
    user_id: userId,
    title: 'Test Audio Timeline Project',
    mode: 'MEDIA_COMPOSER',
    aspect_ratio: '16:9',
    status: 'queued',
  })

  // Ensure default tracks exist
  const tracks = await composerService.ensureDefaultTracks(projId)
  const voiceTrack = tracks.find((t) => t.track_type === 'voiceover')
  const musicTrack = tracks.find((t) => t.track_type === 'music')
  assert.ok(voiceTrack, 'voiceover track exists')
  assert.ok(musicTrack, 'music track exists')

  // Create mock voice and music assets
  const voiceAudioId = 'audio-voice-' + uuidv4().slice(0, 8)
  const musicAssetId = 'asset-music-' + uuidv4().slice(0, 8)

  await insert('audios', {
    id: voiceAudioId,
    project_id: projId,
    storage_key: `projects/${projId}/assets/voice.mp3`,
    duration_sec: 5.5,
  })

  await insert('assets', {
    id: musicAssetId,
    project_id: projId,
    user_id: userId,
    kind: 'audio',
    name: 'bgm.mp3',
    storage_key: `projects/${projId}/assets/bgm.mp3`,
    byte_size: 2048,
    mime_type: 'audio/mpeg',
  })

  // Scenario 1: Clip has duration = 6.5, in_sec = 1.0, but stale out_sec = 4.0 passed in payload
  // saveTimeline must recalculate out_sec = in_sec + duration = 1.0 + 6.5 = 7.5
  // And must preserve voice_audio_id from either audio_id or voice_audio_id
  const payloadClips = [
    {
      id: 'clip-voice-1',
      track_id: voiceTrack.id,
      clip_type: 'voiceover',
      audio_id: voiceAudioId, // passed as audio_id from frontend
      start: 2.0,
      in_sec: 1.0,
      duration: 6.5,
      out_sec: 4.0, // STALE out_sec
      volume: 0.9,
    },
    {
      id: 'clip-music-1',
      track_id: musicTrack.id,
      clip_type: 'music',
      asset_id: musicAssetId,
      start: 0,
      in_sec: 0,
      duration: 12.0,
      volume: 0.6,
    },
  ]

  const saveRes = await composerService.saveTimeline({
    projectId: projId,
    tracks,
    clips: payloadClips,
  })

  assert.equal(saveRes.clips.length, 2, 'Two clips saved')

  const savedVoice = saveRes.clips.find((c) => c.id === 'clip-voice-1')
  assert.ok(savedVoice, 'voice clip saved')
  assert.equal(savedVoice.start_at_sec, 2.0, 'start_at_sec saved from start')
  assert.equal(savedVoice.voice_audio_id, voiceAudioId, 'voice_audio_id preserved from audio_id')
  assert.equal(savedVoice.out_sec, 7.5, 'out_sec recalculated from in_sec + duration (7.5, not stale 4.0)')

  const savedMusic = saveRes.clips.find((c) => c.id === 'clip-music-1')
  assert.ok(savedMusic, 'music clip saved')
  assert.equal(savedMusic.asset_id, musicAssetId, 'asset_id preserved')
  assert.equal(savedMusic.out_sec, 12.0, 'out_sec calculated from duration (12.0)')

  console.log('✓ Audio Timeline Sync & Duration Recalculation Test PASSED')
})
