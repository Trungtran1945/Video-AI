import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_transcript_service_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne, run } = await import('../src/db/query.js')
const {
  TranscriptRevisionConflict,
  TranscriptRevisionRequired,
  TranscriptRunConflict,
  applyTranscriptEdits,
  updateSegmentTranslation,
  applyGeneratedTranslations,
} = await import('../src/services/transcriptMutationService.js')

await initSchema()

let failures = 0
const assert = (condition, message) => {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

const projectId = 'transcript-service-project'
await insert('projects', {
  id: projectId,
  user_id: 'user-transcript-service',
  mode: 'TRANSLATE_DUB',
  title: 'transcript service',
  status: 'completed',
})
await insert('transcript_segments', {
  id: 'transcript-service-segment',
  project_id: projectId,
  index_num: 0,
  start_sec: 0,
  end_sec: 2,
  text: 'hello',
  translation: 'xin chào',
})

let requiredError = null
try {
  await applyTranscriptEdits(projectId, [{ id: 'transcript-service-segment', translation: 'xin chào' }], undefined)
} catch (error) {
  requiredError = error
}
assert(requiredError instanceof TranscriptRevisionRequired, 'missing revision is rejected')

const noOp = await applyTranscriptEdits(
  projectId,
  [{ id: 'transcript-service-segment', translation: 'xin chào' }],
  0
)
const noOpProject = await queryOne('SELECT transcript_version FROM projects WHERE id = ?', [projectId])
assert(noOp.changed === false, 'same transcript state is a no-op')
assert(noOp.revision === 0 && Number(noOpProject.transcript_version) === 0, 'no-op does not bump revision')

const changed = await applyTranscriptEdits(
  projectId,
  [{ id: 'transcript-service-segment', translation: 'xin chào mới' }],
  0
)
const changedSegment = await queryOne('SELECT * FROM transcript_segments WHERE id = ?', ['transcript-service-segment'])
assert(changed.changed === true && changed.revision === 1, 'real translation change bumps once')
assert(changedSegment.translation === 'xin chào mới', 'changed translation is persisted')
assert(Number(changedSegment.is_translation_manually_edited) === 1, 'manual translation flag is persisted')
assert(changedSegment.tts_audio_id === null, 'changed translation invalidates TTS linkage')

const samePatch = await updateSegmentTranslation(projectId, 'transcript-service-segment', 'xin chào mới', 1)
assert(samePatch.changed === false && samePatch.revision === 1, 'same PATCH is a no-op')

const provenanceProjectId = 'transcript-provenance-project'
await insert('projects', {
  id: provenanceProjectId,
  user_id: 'user-transcript-provenance',
  mode: 'TRANSLATE_DUB',
  title: 'provenance',
  status: 'completed',
})
await insert('transcript_segments', {
  id: 'transcript-provenance-segment',
  project_id: provenanceProjectId,
  index_num: 0,
  start_sec: 0,
  end_sec: 1,
  text: 'source',
  translation: 'same translation',
})
const confirmedSame = await updateSegmentTranslation(provenanceProjectId, 'transcript-provenance-segment', 'same translation', 0)
const confirmedSegment = await queryOne('SELECT * FROM transcript_segments WHERE id = ?', ['transcript-provenance-segment'])
assert(confirmedSame.changed === true && confirmedSame.revision === 1, 'confirming an unchanged translation records a revision')
assert(Number(confirmedSegment.is_translation_manually_edited) === 1, 'confirming an unchanged translation marks it manual')

const blankProjectId = 'transcript-blank-provenance-project'
await insert('projects', {
  id: blankProjectId,
  user_id: 'user-transcript-blank',
  mode: 'TRANSLATE_DUB',
  title: 'blank provenance',
  status: 'completed',
})
await insert('transcript_segments', {
  id: 'transcript-blank-provenance-segment',
  project_id: blankProjectId,
  index_num: 0,
  start_sec: 0,
  end_sec: 1,
  text: 'source',
  translation: '',
  is_translation_manually_edited: 1,
})
const blankGenerated = await applyGeneratedTranslations(blankProjectId, [{ id: 'transcript-blank-provenance-segment', translation: 'AI value' }], 0)
const blankSegment = await queryOne('SELECT * FROM transcript_segments WHERE id = ?', ['transcript-blank-provenance-segment'])
assert(blankGenerated.changed === true && blankSegment.translation === 'AI value', 'blank legacy manual flag does not block generated translation')

const generated = await applyGeneratedTranslations(
  projectId,
  [{ id: 'transcript-service-segment', translation: 'AI value' }],
  1
)
const generatedSegment = await queryOne('SELECT * FROM transcript_segments WHERE id = ?', ['transcript-service-segment'])
assert(generated.changed === false && generatedSegment.translation !== 'AI value', 'generated translation cannot overwrite manual translation')

const runProjectId = 'transcript-run-project'
await insert('projects', {
  id: runProjectId,
  user_id: 'run-transcript-user',
  mode: 'TRANSLATE_DUB',
  title: 'run transcript',
  status: 'running',
  run_token: 'run-token',
})
await insert('transcript_segments', {
  id: 'run-transcript-segment',
  project_id: runProjectId,
  index_num: 0,
  start_sec: 0,
  end_sec: 1,
  text: 'source',
  translation: 'old',
})
let runConflict = null
try {
  await applyGeneratedTranslations(runProjectId, [{ id: 'run-transcript-segment', translation: 'stale' }], 0, { runToken: 'old-token' })
} catch (error) {
  runConflict = error
}
assert(runConflict instanceof TranscriptRunConflict, 'pipeline transcript mutation rejects a stale run token')
const runUpdated = await applyGeneratedTranslations(runProjectId, [{ id: 'run-transcript-segment', translation: 'new' }], 0, { runToken: 'run-token' })
assert(runUpdated.changed === true && runUpdated.revision === 1, 'current run token can commit generated translations')

let conflictCount = 0
const concurrent = await Promise.allSettled([
  applyTranscriptEdits(projectId, [{ id: 'transcript-service-segment', text: 'A' }], 1),
  applyTranscriptEdits(projectId, [{ id: 'transcript-service-segment', text: 'B' }], 1),
])
for (const result of concurrent) {
  if (result.status === 'rejected' && result.reason instanceof TranscriptRevisionConflict) conflictCount += 1
}
assert(concurrent.filter((result) => result.status === 'fulfilled').length === 1, 'one concurrent edit commits')
assert(conflictCount === 1, 'one concurrent edit receives a revision conflict')

await run('DELETE FROM transcript_segments WHERE project_id IN (?, ?)', [projectId, runProjectId])
await run('DELETE FROM projects WHERE id IN (?, ?)', [projectId, runProjectId])
fs.rmSync(process.env.DB_PATH, { force: true })

if (failures > 0) process.exit(1)
console.log('ALL PASS')
