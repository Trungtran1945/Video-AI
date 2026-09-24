import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_transcript_coverage_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, query, queryOne, run } = await import('../src/db/query.js')
const {
  replaceTranscript,
  copyTranscript,
  dedupeTranscriptSegments,
  clearTtsLinks,
  attachTtsAudio,
  TranscriptRevisionConflict,
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

const sourceId = 'coverage-source'
const targetId = 'coverage-target'
await insert('projects', { id: sourceId, user_id: 'coverage-user', mode: 'TRANSLATE_DUB', title: 'source' })
await insert('projects', { id: targetId, user_id: 'coverage-user', mode: 'TRANSLATE_DUB', title: 'target' })
await insert('transcript_segments', {
  id: 'coverage-a',
  project_id: sourceId,
  index_num: 0,
  start_sec: 0,
  end_sec: 1,
  text: 'same',
  translation: 'bản dịch',
  is_translation_manually_edited: 1,
  source: 'asr',
  tts_audio_id: 'old-audio',
})

const initial = await replaceTranscript(sourceId, [
  { id: 'coverage-a', index_num: 0, start_sec: 0, end_sec: 1, text: 'changed', translation: 'bản dịch', source: 'asr', is_translation_manually_edited: 1 },
], { expectedRevision: 0 })
assert(initial.revision === 1, 'replacing an existing transcript bumps once')
const imported = await replaceTranscript(sourceId, [
  { id: 'coverage-a', index_num: 0, start_sec: 0, end_sec: 1, text: 'changed', translation: 'bản dịch', source: 'asr', is_translation_manually_edited: 1 },
  { id: 'coverage-b', index_num: 1, start_sec: 1.1, end_sec: 2, text: 'next', translation: null, source: 'asr' },
], { expectedRevision: 1 })
assert(imported.revision === 2, 'replacement import bumps once for changed transcript state')

const copied = await copyTranscript(sourceId, targetId)
const copiedRows = await query('SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num', [targetId])
assert(copied.inserted === 2 && copied.revision === 0, 'cache copy is an initial import at revision zero')
assert(copiedRows[0].is_translation_manually_edited === 1 && copiedRows[0].tts_audio_id === null, 'cache copy preserves provenance but not derived audio links')

await run('UPDATE transcript_segments SET text = ?, tts_audio_id = ? WHERE id = ?', ['changed', 'old-audio', 'coverage-a'])
await run('UPDATE transcript_segments SET text = ?, start_sec = 1, end_sec = 3 WHERE id = ?', ['changed', 'coverage-b'])
const deduped = await dedupeTranscriptSegments(sourceId, 2)
const keeperAfterDedupe = await queryOne('SELECT * FROM transcript_segments WHERE id = ?', ['coverage-a'])
assert(deduped.removedCount === 1 && deduped.revision === 3, `dedupe changes transcript revision once (${JSON.stringify(deduped)})`)
assert(keeperAfterDedupe.tts_audio_id === null, `dedupe invalidates keeper TTS linkage (${JSON.stringify(keeperAfterDedupe)})`)

const tts = await attachTtsAudio(sourceId, 'coverage-a', 'new-audio', 3)
assert(tts.changed === true && tts.revision === 3, 'TTS linkage is derived metadata and does not bump transcript revision')
let ttsConflict = false
try {
  await attachTtsAudio(sourceId, 'coverage-a', 'stale-audio', 2)
} catch (error) {
  ttsConflict = error instanceof TranscriptRevisionConflict
}
assert(ttsConflict, 'TTS linkage rejects a stale transcript snapshot')
const cleared = await clearTtsLinks(sourceId, 3)
assert(cleared.changed === true, 'TTS invalidation is centralized')

const files = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.js')) files.push(full)
  }
}
walk(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src'))
const servicePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'transcriptMutationService.js')
const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'schema.js')
const mergeStagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pipeline', 'stages', 'dubMerge.js')
const mergeStageSource = fs.readFileSync(mergeStagePath, 'utf8')
assert(mergeStageSource.includes('expectedRevision = null, options = {}'), 'dub.merge passes run-token options through the dedupe service')
assert(mergeStageSource.includes('mutateDedupeTranscriptSegments(projectId, expectedRevision, options)'), 'dub.merge forwards run-token options to the dedupe service')
const stageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pipeline', 'stages')
for (const [stageName, providerCall] of [['dubStt.js', 'await getProvider'], ['dubOcr.js', 'await getProvider']]) {
  const stageSource = fs.readFileSync(path.join(stageRoot, stageName), 'utf8')
  const snapshotIndex = stageSource.indexOf('const transcriptVersion =')
  const providerIndex = stageSource.indexOf(providerCall)
  assert(snapshotIndex >= 0 && providerIndex > snapshotIndex, `${stageName} captures transcript revision before provider work`)
  assert(stageSource.includes('expectedRevision: transcriptVersion'), `${stageName} uses its immutable revision snapshot`)
}
const bypasses = files.filter((file) => file !== servicePath && file !== schemaPath && /transcript_segments[\s\S]{0,100}(?:UPDATE|DELETE FROM|INSERT INTO|insert\(|updateById\()/.test(fs.readFileSync(file, 'utf8')))
assert(bypasses.length === 0, `production transcript mutations are centralized (${bypasses.join(', ')})`)

await run('DELETE FROM transcript_segments WHERE project_id IN (?, ?)', [sourceId, targetId])
await run('DELETE FROM projects WHERE id IN (?, ?)', [sourceId, targetId])
fs.rmSync(process.env.DB_PATH, { force: true })
if (failures > 0) process.exit(1)
console.log('ALL PASS')
