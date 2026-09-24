import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_output_version_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne, run } = await import('../src/db/query.js')
const { createOutput, getOutputState, OutputRunConflict } = await import('../src/services/outputService.js')

await initSchema()

let failures = 0
const assert = (condition, message) => {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

const outputRouteSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes', 'v1', 'outputs.js'), 'utf8')
assert(outputRouteSource.includes('project_transcript_version'), 'output API preserves the project revision separately from the output snapshot')

const projectId = 'output-version-project'
await insert('projects', {
  id: projectId,
  user_id: 'output-version-user',
  mode: 'TRANSLATE_DUB',
  title: 'output version',
  status: 'completed',
  transcript_version: 7,
})
await createOutput({
  id: 'output-version-7',
  projectId,
  storageKey: 'projects/output-version-project/final.mp4',
  durationSec: 2,
  transcriptVersion: 7,
})
let state = await getOutputState(projectId)
assert(state.outputStale === false, 'matching output version is current')
assert(state.output.id === 'output-version-7', 'state returns the latest output')

await run('UPDATE projects SET transcript_version = 8 WHERE id = ?', [projectId])
await createOutput({
  id: 'output-version-old',
  projectId,
  storageKey: 'projects/output-version-project/old.mp4',
  durationSec: 2,
  transcriptVersion: 7,
})
state = await getOutputState(projectId)
assert(state.output.id === 'output-version-old', 'latest output is selected deterministically')
assert(state.output.transcript_version === 7 && state.outputStale === true, 'render snapshot remains stale after an edit')

await createOutput({
  id: 'output-version-8',
  projectId,
  storageKey: 'projects/output-version-project/current.mp4',
  durationSec: 2,
  transcriptVersion: 8,
})
state = await getOutputState(projectId)
assert(state.outputStale === false, 'new output at the current transcript version is fresh')

const runProjectId = 'output-run-project'
await insert('projects', {
  id: runProjectId,
  user_id: 'output-version-user',
  mode: 'TRANSLATE_DUB',
  title: 'run output',
  status: 'running',
  run_token: 'run-token',
  transcript_version: 2,
})
let runConflict = false
try {
  await createOutput({ id: 'wrong-run-output', projectId: runProjectId, storageKey: 'wrong.mp4', durationSec: 1, transcriptVersion: 2, runToken: 'stale-token' })
} catch (error) {
  runConflict = error instanceof OutputRunConflict
}
assert(runConflict, 'output publication rejects a stale run token')
await createOutput({ id: 'right-run-output', projectId: runProjectId, storageKey: 'right.mp4', durationSec: 1, transcriptVersion: 2, runToken: 'run-token' })
assert((await getOutputState(runProjectId)).output.id === 'right-run-output', 'current run token can publish its output')

const summaryId = 'output-summary-project'
await insert('projects', { id: summaryId, user_id: 'output-version-user', mode: 'SUMMARY', title: 'summary', status: 'completed' })
await createOutput({ id: 'output-summary-1', projectId: summaryId, storageKey: 'outputs/summary.mp4', durationSec: 2, transcriptVersion: null })
const summaryState = await getOutputState(summaryId)
assert(summaryState.output.transcript_version === null && summaryState.outputStale === false, 'summary output does not use transcript freshness')

await run('DELETE FROM outputs WHERE project_id IN (?, ?, ?)', [projectId, runProjectId, summaryId])
await run('DELETE FROM projects WHERE id IN (?, ?, ?)', [projectId, runProjectId, summaryId])
fs.rmSync(process.env.DB_PATH, { force: true })

if (failures > 0) process.exit(1)
console.log('ALL PASS')
