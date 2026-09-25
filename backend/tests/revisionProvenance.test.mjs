// Transcript revision provenance: ONE snapshot per TRANSLATE_DUB generation.
// - dub.ttsAlign / dub.render refuse to run without a runner-provided snapshot
// - resume after a successful ttsAlign reuses the frozen snapshot (never
//   re-reads projects.transcript_version mid-generation)
// - outputs are published at the generation snapshot, not the current revision
// Run: node backend/tests/revisionProvenance.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-provenance-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne, run } = await import('../src/db/query.js')
const { resolveGenerationSnapshot } = await import('../src/pipeline/runner.js')
const { default: dubTtsAlign } = await import('../src/pipeline/stages/dubTtsAlign.js')
const { default: dubRender } = await import('../src/pipeline/stages/dubRender.js')
const { createOutput } = await import('../src/services/outputService.js')

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }
const readSrc = (...parts) => fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8')

// ── 1. Stages fail fast without a generation snapshot ──
{
  let err = null
  try {
    await dubTtsAlign({ project: { id: 'prov-no-snap', params: '{}' }, job: {}, setProgress: () => {}, signal: undefined, transcriptVersionSnapshot: null })
  } catch (e) { err = e }
  assert(err?.code === 'TRANSCRIPT_SNAPSHOT_MISSING', `dub.ttsAlign rejects a null snapshot (got: ${err?.code || err?.message})`)

  err = null
  try {
    await dubTtsAlign({ project: { id: 'prov-no-snap', params: '{}' }, job: {}, setProgress: () => {}, signal: undefined })
  } catch (e) { err = e }
  assert(err?.code === 'TRANSCRIPT_SNAPSHOT_MISSING', 'dub.ttsAlign rejects a missing snapshot')

  err = null
  try {
    await dubRender({ project: { id: 'prov-no-snap', params: '{}' }, setProgress: () => {}, signal: undefined })
  } catch (e) { err = e }
  assert(err?.code === 'GENERATION_SNAPSHOT_MISSING', `dub.render rejects a null snapshot (got: ${err?.code || err?.message})`)

  err = null
  try {
    await dubRender({ project: { id: 'prov-no-snap', params: '{}' }, setProgress: () => {}, signal: undefined, transcriptVersionSnapshot: 1.5 })
  } catch (e) { err = e }
  assert(err?.code === 'GENERATION_SNAPSHOT_MISSING', 'dub.render rejects a non-integer snapshot')
}

// ── 2. dub.ttsAlign publishes the snapshot it synthesized from (skip path) ──
{
  await insert('projects', {
    id: 'prov-skip',
    user_id: 'prov-user',
    mode: 'TRANSLATE_DUB',
    title: 'skip path',
    params: JSON.stringify({ enableDubbing: false }),
    transcript_version: 5,
  })
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', ['prov-skip'])
  const result = await dubTtsAlign({
    project,
    job: { id: 'prov-skip-job' },
    setProgress: () => {},
    signal: undefined,
    transcriptVersionSnapshot: 5,
  })
  assert(result?.skipped === true && result?.transcriptVersionSnapshot === 5,
    `skipped ttsAlign still returns its snapshot (got: ${JSON.stringify(result)})`)
}

// ── 3. Resume resolution: frozen snapshot vs current revision ──
{
  const projectId = 'prov-resume'
  await insert('projects', {
    id: projectId,
    user_id: 'prov-user',
    mode: 'TRANSLATE_DUB',
    title: 'resume',
    params: JSON.stringify({}),
    transcript_version: 9,
  })
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])

  // No successful ttsAlign yet → capture the current revision.
  let snapshot = await resolveGenerationSnapshot(projectId, 'dub.render', project)
  assert(snapshot === 9, `no frozen snapshot → capture current (got ${snapshot})`)

  // Legacy successful ttsAlign without a persisted snapshot → current + warn.
  await insert('generation_jobs', {
    id: 'prov-job-legacy',
    project_id: projectId,
    type: 'dub.ttsAlign',
    status: 'success',
    result: JSON.stringify({ dubbedCount: 3 }),
  })
  snapshot = await resolveGenerationSnapshot(projectId, 'dub.render', project)
  assert(snapshot === 9, `legacy job result without snapshot → capture current (got ${snapshot})`)

  // Successful ttsAlign with a frozen snapshot → render-only resume reuses it.
  await run('UPDATE generation_jobs SET result = ? WHERE id = ?', [JSON.stringify({ dubbedCount: 3, transcriptVersionSnapshot: 7 }), 'prov-job-legacy'])
  snapshot = await resolveGenerationSnapshot(projectId, 'dub.render', project)
  assert(snapshot === 7, `render-only resume reuses the frozen snapshot (got ${snapshot})`)

  // Job not successful → never trust its result.
  await run('UPDATE generation_jobs SET status = ? WHERE id = ?', ['retry', 'prov-job-legacy'])
  snapshot = await resolveGenerationSnapshot(projectId, 'dub.render', project)
  assert(snapshot === 9, `unsuccessful ttsAlign result is ignored (got ${snapshot})`)
  await run('UPDATE generation_jobs SET status = ? WHERE id = ?', ['success', 'prov-job-legacy'])

  // Any resume that re-runs ttsAlign captures current, even with a frozen job.
  snapshot = await resolveGenerationSnapshot(projectId, 'dub.stt', project)
  assert(snapshot === 9, `ttsAlign re-run captures current over the frozen snapshot (got ${snapshot})`)
  snapshot = await resolveGenerationSnapshot(projectId, null, project)
  assert(snapshot === 9, `fresh run captures current (got ${snapshot})`)

  await run('DELETE FROM generation_jobs WHERE project_id = ?', [projectId])
}

// ── 4. Output provenance matches the generation snapshot ──
{
  const projectId = 'prov-out'
  await insert('projects', {
    id: projectId,
    user_id: 'prov-user',
    mode: 'TRANSLATE_DUB',
    title: 'output provenance',
    status: 'completed',
    transcript_version: 9,
  })
  await insert('generation_jobs', {
    id: 'prov-out-tts-job',
    project_id: projectId,
    type: 'dub.ttsAlign',
    status: 'success',
    result: JSON.stringify({ transcriptVersionSnapshot: 7 }),
  })

  const outputAtSnapshot = await createOutput({
    id: 'prov-out-7',
    projectId,
    storageKey: 'projects/prov-out/final.mp4',
    durationSec: 1,
    transcriptVersion: 7,
  })
  assert(outputAtSnapshot?.id === 'prov-out-7', 'output at the generation snapshot is published')

  let mismatch = null
  try {
    await createOutput({
      id: 'prov-out-9',
      projectId,
      storageKey: 'projects/prov-out/final-9.mp4',
      durationSec: 1,
      transcriptVersion: 9,
    })
  } catch (e) { mismatch = e }
  assert(mismatch && /snapshot/.test(mismatch.message),
    `output at the CURRENT revision is rejected (got: ${mismatch?.message})`)

  // Legacy generation (job result without snapshot) keeps publishing.
  await run('UPDATE generation_jobs SET result = ? WHERE id = ?', [JSON.stringify({ dubbedCount: 2 }), 'prov-out-tts-job'])
  const legacy = await createOutput({
    id: 'prov-out-legacy',
    projectId,
    storageKey: 'projects/prov-out/final-legacy.mp4',
    durationSec: 1,
    transcriptVersion: 9,
  })
  assert(legacy?.id === 'prov-out-legacy', 'legacy generation without a persisted snapshot still publishes')

  await run('DELETE FROM outputs WHERE project_id = ?', [projectId])
  await run('DELETE FROM generation_jobs WHERE project_id = ?', [projectId])
}

// ── 5. Source fences: no mid-generation re-reads ──
{
  const renderSrc = readSrc('pipeline', 'stages', 'dubRender.js')
  assert(!renderSrc.includes('SELECT transcript_version FROM projects'), 'dub.render never re-reads the current revision')
  assert(renderSrc.includes('GENERATION_SNAPSHOT_MISSING'), 'dub.render fails fast on a missing snapshot')
  const ttsSrc = readSrc('pipeline', 'stages', 'dubTtsAlign.js')
  assert(!ttsSrc.includes('SELECT transcript_version FROM projects'), 'dub.ttsAlign never re-reads the current revision')
  assert(ttsSrc.includes('TRANSCRIPT_SNAPSHOT_MISSING'), 'dub.ttsAlign fails fast on a missing snapshot')
  const runnerSrc = readSrc('pipeline', 'runner.js')
  assert(runnerSrc.includes('resolveGenerationSnapshot'), 'runner resolves the snapshot at the generation boundary')
  assert(runnerSrc.includes('transcriptVersionSnapshot: generation.transcriptVersionSnapshot'), 'runner hands the generation snapshot to every stage')
}

await run('DELETE FROM projects WHERE id IN (?, ?, ?)', ['prov-skip', 'prov-resume', 'prov-out'])
fs.rmSync(tmpRoot, { recursive: true, force: true })
if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
