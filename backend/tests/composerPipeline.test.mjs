import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_composer_pipeline_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne, run } = await import('../src/db/query.js')
const { projectDir, ensureDir } = await import('../src/pipeline/context.js')
const {
  STAGES,
  stagesForProject,
  isComposerMode,
} = await import('../src/pipeline/runner.js')
const { composerIngest } = await import('../src/pipeline/stages/composerIngest.js')
const { composerPrepare } = await import('../src/pipeline/stages/composerPrepare.js')
const { composerRender } = await import('../src/pipeline/stages/composerRender.js')

await initSchema()

console.log('=== AI Media Composer Pipeline Workflow Tests ===\n')

const testUserId = 'user-composer-pipeline-1'
await insert('users', {
  id: testUserId,
  email: 'composer-pipe@test.local',
  role: 'user',
  password: 'hash',
})

// 1. Stage list contract
{
  console.log('--- 1. STAGES.MEDIA_COMPOSER contract ---')
  const expected = ['composer.ingest', 'composer.prepare', 'composer.render']
  assert.deepEqual(STAGES.MEDIA_COMPOSER, expected, 'MEDIA_COMPOSER has exactly 3 stages')

  const stages1 = stagesForProject('MEDIA_COMPOSER')
  assert.deepEqual(stages1, expected, 'stagesForProject returns 3 stages for string mode')

  const stages2 = stagesForProject({ mode: 'MEDIA_COMPOSER' })
  assert.deepEqual(stages2, expected, 'stagesForProject returns 3 stages for project object')

  assert.equal(isComposerMode('MEDIA_COMPOSER'), true, 'Recognizes uppercase mode')
  assert.equal(isComposerMode('media_composer'), true, 'Recognizes lowercase mode')
  assert.equal(isComposerMode('TRANSLATE_DUB'), false, 'Non-composer mode returns false')
}

// 2. Stage implementations check
{
  console.log('--- 2. Stage function exports check ---')
  assert.equal(typeof composerIngest, 'function', 'composerIngest is a function')
  assert.equal(typeof composerPrepare, 'function', 'composerPrepare is a function')
  assert.equal(typeof composerRender, 'function', 'composerRender is a function')
}

// 3. composerIngest stage execution
{
  console.log('--- 3. composerIngest auto-arranges and computes duration ---')
  const projectId = 'proj-pipe-ingest-1'
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    title: 'Test Composer Ingest',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
  })

  // Create test dummy asset
  const pDir = projectDir(projectId)
  const assetsDir = ensureDir(path.join(pDir, 'assets'))
  const imgPath = path.join(assetsDir, 'slide_ingest_1.png')
  fs.writeFileSync(imgPath, Buffer.from('test-png-image-data'))

  await insert('assets', {
    id: 'asset-ingest-1',
    project_id: projectId,
    user_id: testUserId,
    kind: 'image',
    name: 'slide_ingest_1.png',
    storage_key: `projects/${projectId}/assets/slide_ingest_1.png`,
    order_index: 0,
  })

  const job = { id: 'job-ingest-1', project_id: projectId }
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])

  const ingestRes = await composerIngest({ project, job })
  assert.ok(ingestRes, 'Ingest returns result object')
  assert.equal(ingestRes.clipsCount, 2, 'Auto-arranged 2 clips (1 bg + 1 image)')
  assert.equal(ingestRes.durationSec, 4, 'Total duration 4s for single image')

  // Verify project updated
  const updatedProject = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  assert.equal(updatedProject.target_duration_sec, 4, 'target_duration_sec recorded')
}

// 4. composerPrepare stage execution (ASS subtitles)
{
  console.log('--- 4. composerPrepare stage creates ASS subtitle file ---')
  const projectId = 'proj-pipe-prepare-1'
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    title: 'Test Composer Prepare',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
    params: JSON.stringify({ resolution: '1080p', aspectRatio: '16:9' }),
  })

  const pDir = projectDir(projectId)
  const assetsDir = ensureDir(path.join(pDir, 'assets'))
  const imgPath = path.join(assetsDir, 'slide_prep.png')
  fs.writeFileSync(imgPath, Buffer.from('test-image-bytes'))

  await insert('assets', {
    id: 'asset-prep-1',
    project_id: projectId,
    user_id: testUserId,
    kind: 'image',
    name: 'slide_prep.png',
    storage_key: `projects/${projectId}/assets/slide_prep.png`,
    order_index: 0,
  })

  await insert('timeline_clips', {
    id: 'clip-prep-text-1',
    project_id: projectId,
    clip_type: 'text',
    start_at_sec: 0.5,
    out_sec: 3.5,
    text_content: 'Chào mừng bạn đến với AI Media Composer',
    style_json: JSON.stringify({ fontSize: 32, color: '#FFFFFF', position: 'bottom' }),
  })

  const job = { id: 'job-prep-1', project_id: projectId }
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])

  const prepRes = await composerPrepare({ project, job })
  assert.ok(prepRes, 'Prepare stage returns result')
  assert.equal(prepRes.textClipsCount, 1, 'Prepared 1 text overlay')
  assert.ok(prepRes.assPath, 'ASS subtitle path generated')
  assert.ok(fs.existsSync(prepRes.assPath), 'ASS subtitle file was written to disk')

  const assContent = fs.readFileSync(prepRes.assPath, 'utf8')
  assert.ok(assContent.includes('[Script Info]'), 'Valid ASS header')
  assert.ok(assContent.includes('Chào mừng bạn đến với AI Media Composer'), 'Contains text overlay dialogue')
}

// 5. composerIngest with existing clips preserves manual arrangement
{
  console.log('--- 5. composerIngest preserves existing manual clips ---')
  const projectId = 'proj-pipe-ingest-manual'
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    title: 'Test Composer Manual',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
  })
  await insert('timeline_clips', {
    id: 'clip-manual-pres-1',
    project_id: projectId,
    clip_type: 'image',
    start_at_sec: 0,
    in_sec: 0,
    out_sec: 8.5,
  })

  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  const ingestRes = await composerIngest({ project, job: { id: 'job-man-1', project_id: projectId } })
  assert.equal(ingestRes.clipsCount, 1, 'Preserves exactly 1 existing clip without auto-arranging')
  assert.equal(ingestRes.durationSec, 8.5, 'Duration matches manual clip')
}

// 6. composerPrepare without text clips
{
  console.log('--- 6. composerPrepare without text clips returns null assPath ---')
  const projectId = 'proj-pipe-no-text'
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    title: 'Test Composer No Text',
    mode: 'MEDIA_COMPOSER',
    status: 'queued',
  })
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  const prepRes = await composerPrepare({ project, job: { id: 'job-no-text-1', project_id: projectId } })
  assert.equal(prepRes.textClipsCount, 0, '0 text clips')
  assert.equal(prepRes.assPath, null, 'assPath is null when no text clips exist')
}

console.log('\nALL PASS: AI Media Composer Pipeline Workflow tests passed.')

process.exit(0)
