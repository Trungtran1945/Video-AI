import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_yt_state_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)
process.env.JWT_SECRET = 'test-secret-key-for-youtube-state'

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne, run } = await import('../src/db/query.js')
const { createOutput, getOutputState } = await import('../src/services/outputService.js')

await initSchema()

let failures = 0
const assert = (condition, message) => {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

try {
  console.log('=== projectYoutubeState.test.mjs ===')

  // 1. Project without output
  const p0 = 'p-no-output'
  await insert('projects', {
    id: p0,
    user_id: 'user-1',
    mode: 'SCRIPT_TO_VIDEO',
    title: 'No Output Project',
    status: 'pending',
    script_version: 1,
  })

  let state0 = await getOutputState(p0)
  assert(state0.output === null, 'Project without output returns output: null')
  assert(state0.youtubeUpload === null, 'Project without output returns youtubeUpload: null')

  // 2. Project with output but no YouTube upload
  const p1 = 'p-output-no-yt'
  await insert('projects', {
    id: p1,
    user_id: 'user-1',
    mode: 'SCRIPT_TO_VIDEO',
    title: 'Output without YouTube',
    status: 'completed',
    script_version: 1,
  })
  const out1 = 'out-1-no-yt'
  await createOutput({
    id: out1,
    projectId: p1,
    storageKey: 'projects/p-output-no-yt/final.mp4',
    durationSec: 10,
    scriptVersion: 1,
  })

  let state1 = await getOutputState(p1)
  assert(state1.output !== null, 'Output exists')
  assert(state1.output.id === out1, 'Output id matches')
  assert(state1.output.youtubeUpload === null, 'output.youtubeUpload is null when not uploaded to YouTube')
  assert(state1.youtubeUpload === null, 'state1.youtubeUpload is null when not uploaded to YouTube')

  // 3. Project with successful YouTube upload
  const p2 = 'p-output-with-yt'
  await insert('projects', {
    id: p2,
    user_id: 'user-1',
    mode: 'SCRIPT_TO_VIDEO',
    title: 'Output with YouTube',
    status: 'completed',
    script_version: 1,
  })
  const out2 = 'out-2-with-yt'
  await createOutput({
    id: out2,
    projectId: p2,
    storageKey: 'projects/p-output-with-yt/final.mp4',
    durationSec: 15,
    scriptVersion: 1,
  })

  await insert('youtube_uploads', {
    id: 'yt-upload-1',
    output_id: out2,
    project_id: p2,
    status: 'completed',
    youtube_video_id: 'yt123456789',
    youtube_url: 'https://youtu.be/yt123456789',
    privacy: 'unlisted',
    progress: 100,
    error_message: null,
    created_date: '2026-11-03T10:00:00Z',
    updated_at: '2026-11-03T10:05:00Z',
  })

  let state2 = await getOutputState(p2)
  assert(state2.output !== null, 'state2 has output')
  assert(state2.output.youtubeUpload !== null, 'state2.output.youtubeUpload is attached')
  assert(state2.output.youtubeUpload.status === 'completed', 'youtubeUpload status is completed')
  assert(state2.output.youtubeUpload.youtubeVideoId === 'yt123456789', 'youtubeVideoId is yt123456789')
  assert(state2.output.youtubeUpload.youtubeVideoUrl === 'https://youtu.be/yt123456789', 'youtubeVideoUrl matches')
  assert(state2.output.youtubeUpload.privacy === 'unlisted', 'privacy is unlisted')
  assert(state2.output.youtubeUpload.errorMessage === null, 'errorMessage is null')
  assert(state2.output.youtubeUpload.progress === 100, 'progress is 100')

  // 4. Failed YouTube upload
  const p3 = 'p-output-failed-yt'
  await insert('projects', {
    id: p3,
    user_id: 'user-1',
    mode: 'TRANSLATE_DUB',
    title: 'Output with failed YouTube',
    status: 'completed',
    transcript_version: 2,
  })
  const out3 = 'out-3-failed-yt'
  await createOutput({
    id: out3,
    projectId: p3,
    storageKey: 'projects/p-output-failed-yt/final.mp4',
    durationSec: 20,
    transcriptVersion: 2,
  })

  await insert('youtube_uploads', {
    id: 'yt-upload-failed',
    output_id: out3,
    project_id: p3,
    status: 'failed',
    youtube_video_id: null,
    youtube_url: null,
    privacy: 'private',
    progress: 45,
    error_message: 'YouTube daily upload quota exceeded',
    created_date: '2026-11-03T11:00:00Z',
    updated_at: '2026-11-03T11:02:00Z',
  })

  let state3 = await getOutputState(p3)
  assert(state3.output.youtubeUpload !== null, 'state3.output.youtubeUpload is attached')
  assert(state3.output.youtubeUpload.status === 'failed', 'youtubeUpload status is failed')
  assert(state3.output.youtubeUpload.errorMessage === 'YouTube daily upload quota exceeded', 'error message preserved')
  assert(state3.output.youtubeUpload.youtubeVideoUrl === null, 'video URL is null on failure')

  // 5. Retry / update upload status for same output
  await run(
    `UPDATE youtube_uploads SET status = 'uploading', progress = 60, error_message = NULL, updated_at = '2026-11-03T12:01:00Z'
     WHERE output_id = ?`,
    [out3]
  )

  let state3Retry = await getOutputState(p3)
  assert(state3Retry.output.youtubeUpload.id === 'yt-upload-failed', 'Upload record updated')
  assert(state3Retry.output.youtubeUpload.status === 'uploading', 'Status reflects updated upload')
  assert(state3Retry.output.youtubeUpload.progress === 60, 'Progress reflects updated upload')

  // 6. Cross-project isolation
  // Verify p1 still has null youtubeUpload despite p2 and p3 having uploads
  let state1Check = await getOutputState(p1)
  assert(state1Check.output.youtubeUpload === null, 'p1 output youtubeUpload remains null (isolation verified)')

  if (failures > 0) {
    console.error(`\n${failures} TEST(S) FAILED`)
    process.exit(1)
  }
  console.log('\nALL PASS')
  process.exit(0)
} catch (err) {
  console.error('Unhandled error in test:', err)
  process.exit(1)
} finally {
  try {
    if (process.env.DB_PATH && fs.existsSync(process.env.DB_PATH)) {
      fs.unlinkSync(process.env.DB_PATH)
    }
  } catch (_) {}
}
