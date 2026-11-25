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
const { resolveGenerationSnapshot, getActiveGenerationProvenance } = await import('../src/pipeline/runner.js')
const { default: dubTtsAlign } = await import('../src/pipeline/stages/dubTtsAlign.js')
const { default: dubRender } = await import('../src/pipeline/stages/dubRender.js')
const { createOutput, outputIsStale } = await import('../src/services/outputService.js')

await initSchema()
await run(`INSERT INTO users (id, email, password, role) VALUES ('prov-user', 'prov-user@test.local', 'hash', 'user') ON CONFLICT (id) DO NOTHING`)

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

// ── 4b. Strict snapshot semantics: LEGACY_GENERATION falls back, a declared
//        but unusable snapshot never silently becomes the current revision ──
{
  const projectId = 'prov-strict'
  await insert('projects', {
    id: projectId,
    user_id: 'prov-user',
    mode: 'TRANSLATE_DUB',
    title: 'strict snapshot',
    params: JSON.stringify({}),
    transcript_version: 12,
  })
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  await insert('generation_jobs', {
    id: 'prov-strict-job',
    project_id: projectId,
    type: 'dub.ttsAlign',
    status: 'success',
    result: JSON.stringify({ dubbedCount: 1, transcriptVersionSnapshot: 'not-a-number' }),
  })

  let err = null
  try { await resolveGenerationSnapshot(projectId, 'dub.render', project) } catch (e) { err = e }
  assert(err && err.message.includes('GenerationProvenance'),
    `corrupt snapshot refuses a silent fallback (got: ${String(err?.message).slice(0, 90)})`)

  await run('UPDATE generation_jobs SET result = ? WHERE id = ?',
    [JSON.stringify({ dubbedCount: 1, transcriptVersionSnapshot: 2.5 }), 'prov-strict-job'])
  err = null
  try { await resolveGenerationSnapshot(projectId, 'dub.render', project) } catch (e) { err = e }
  assert(err !== null, 'a non-integer persisted snapshot refuses a silent fallback')

  await run('UPDATE generation_jobs SET result = ? WHERE id = ?',
    [JSON.stringify({ dubbedCount: 1 }), 'prov-strict-job'])
  const legacy = await resolveGenerationSnapshot(projectId, 'dub.render', project)
  assert(legacy === 12, `LEGACY_GENERATION (no snapshot key at all) still falls back to current (got ${legacy})`)

  await run('UPDATE generation_jobs SET result = ? WHERE id = ?',
    [JSON.stringify({ dubbedCount: 1, transcriptVersionSnapshot: 11 }), 'prov-strict-job'])
  const frozen = await resolveGenerationSnapshot(projectId, 'dub.render', project)
  assert(frozen === 11, `a usable frozen snapshot always wins over the current revision (got ${frozen})`)

  await run('DELETE FROM generation_jobs WHERE project_id = ?', [projectId])
  await run('DELETE FROM projects WHERE id = ?', [projectId])
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
  assert(runnerSrc.includes('LEGACY_GENERATION'), 'runner labels the legacy fallback instead of failing silently')
  assert(runnerSrc.includes('idx_generation_jobs_project_type'), 'runner documents the one-current-job-per-stage generation identity')
}

// ── 6. Dubbing disabled: stale ttsAlign job does NOT throw mismatch ──
{
  const projectId = 'prov-dub-off'
  await insert('projects', {
    id: projectId,
    user_id: 'prov-user',
    mode: 'TRANSLATE_DUB',
    title: 'dubbing disabled with stale tts job',
    status: 'running',
    params: JSON.stringify({ enableDubbing: false }),
    transcript_version: 11,
  })
  // Stale ttsAlign job from earlier when dubbing was on
  await insert('generation_jobs', {
    id: 'prov-stale-tts-job',
    project_id: projectId,
    type: 'dub.ttsAlign',
    status: 'success',
    result: JSON.stringify({ transcriptVersionSnapshot: 10 }),
  })

  // createOutput at version 11 must succeed (not throw mismatch)
  let err = null
  let out = null
  try {
    out = await createOutput({
      id: 'prov-out-dub-off',
      projectId,
      storageKey: 'projects/prov-dub-off/final.mp4',
      durationSec: 1,
      transcriptVersion: 11,
    })
  } catch (e) {
    err = e
  }
  assert(!err, `dubbing disabled does not throw mismatch on stale ttsAlign job (err: ${err?.message})`)
  assert(out?.id === 'prov-out-dub-off', 'output published successfully when dubbing is disabled')

  // Also test with audioMode = 'ORIGINAL_ONLY'
  await run('UPDATE projects SET params = ? WHERE id = ?', [JSON.stringify({ audioMode: 'ORIGINAL_ONLY' }), projectId])
  err = null
  out = null
  try {
    out = await createOutput({
      id: 'prov-out-orig-only',
      projectId,
      storageKey: 'projects/prov-dub-off/final-orig.mp4',
      durationSec: 1,
      transcriptVersion: 11,
    })
  } catch (e) {
    err = e
  }
  assert(!err, `audioMode=ORIGINAL_ONLY does not throw mismatch on stale ttsAlign job (err: ${err?.message})`)
  assert(out?.id === 'prov-out-orig-only', 'output published successfully with audioMode=ORIGINAL_ONLY')

  await run('DELETE FROM outputs WHERE project_id = ?', [projectId])
  await run('DELETE FROM generation_jobs WHERE project_id = ?', [projectId])
  await run('DELETE FROM projects WHERE id = ?', [projectId])
}

// ── 6b. enableDubbing=true + audioMode: ORIGINAL_ONLY does not throw, DUB_MIX throws ──
{
  const projectId = 'prov-dub-mix-check'
  await insert('projects', {
    id: projectId,
    user_id: 'prov-user',
    mode: 'TRANSLATE_DUB',
    title: 'audioMode mismatch checks',
    status: 'running',
    params: JSON.stringify({ enableDubbing: true, audioMode: 'ORIGINAL_ONLY' }),
    transcript_version: 11,
  })
  // Stale ttsAlign job snapshot 10
  await insert('generation_jobs', {
    id: 'prov-job-snap-10',
    project_id: projectId,
    type: 'dub.ttsAlign',
    status: 'success',
    result: JSON.stringify({ transcriptVersionSnapshot: 10 }),
  })

  // 1. ORIGINAL_ONLY with enableDubbing:true + snapshot 10 + version 11 -> createOutput does NOT throw
  let err = null
  let out = null
  try {
    const params = { enableDubbing: true, audioMode: 'ORIGINAL_ONLY' }
    out = await createOutput({
      id: 'prov-out-orig-only-11',
      projectId,
      storageKey: 'projects/prov-dub-mix-check/final-orig.mp4',
      durationSec: 1,
      transcriptVersion: 11,
      generationSnapshot: 11,
      isTtsActive: params.enableDubbing && params.audioMode !== 'ORIGINAL_ONLY',
    })
  } catch (e) {
    err = e
  }
  assert(!err, `enableDubbing=true + ORIGINAL_ONLY does not throw mismatch on stale ttsAlign job (err: ${err?.message})`)
  assert(out?.id === 'prov-out-orig-only-11', 'output published with enableDubbing=true + ORIGINAL_ONLY')

  // 2. DUB_MIX with enableDubbing:true + snapshot 10 + version 11 -> createOutput STILL throws
  await run('UPDATE projects SET params = ? WHERE id = ?', [JSON.stringify({ enableDubbing: true, audioMode: 'DUB_MIX' }), projectId])
  let mismatchErr = null
  try {
    const params = { enableDubbing: true, audioMode: 'DUB_MIX' }
    await createOutput({
      id: 'prov-out-dub-mix-11',
      projectId,
      storageKey: 'projects/prov-dub-mix-check/final-dub-mix.mp4',
      durationSec: 1,
      transcriptVersion: 11,
      generationSnapshot: 11,
      isTtsActive: params.enableDubbing && params.audioMode !== 'ORIGINAL_ONLY',
    })
  } catch (e) {
    mismatchErr = e
  }
  assert(mismatchErr && /snapshot/.test(mismatchErr.message),
    `enableDubbing=true + DUB_MIX STILL throws mismatch when version (11) != snapshot (10) (got: ${mismatchErr?.message})`)

  await run('DELETE FROM outputs WHERE project_id = ?', [projectId])
  await run('DELETE FROM generation_jobs WHERE project_id = ?', [projectId])
  await run('DELETE FROM projects WHERE id = ?', [projectId])
}

// ── 7. Approve mask -> bump transcript_version -> regenerate render-only -> output published & not stale ──
{
  const projectId = 'prov-mask-regen'
  await insert('projects', {
    id: projectId,
    user_id: 'prov-user',
    mode: 'TRANSLATE_DUB',
    title: 'approve mask regen',
    status: 'completed',
    params: JSON.stringify({ enableDubbing: false }),
    transcript_version: 10,
  })

  // Simulate mask approval bumping transcript_version to 11
  await run('UPDATE projects SET transcript_version = 11 WHERE id = ?', [projectId])
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])

  // Resolve generation snapshot for render-only resume
  const snapshot = await resolveGenerationSnapshot(projectId, 'dub.render', project)
  assert(snapshot === 11, `render-only snapshot captures bumped transcript_version 11 (got ${snapshot})`)

  // Publish output with snapshot 11
  const out = await createOutput({
    id: 'prov-out-mask-11',
    projectId,
    storageKey: 'projects/prov-mask-regen/final-11.mp4',
    durationSec: 1,
    transcriptVersion: snapshot,
    generationSnapshot: snapshot,
    isTtsActive: false,
  })
  assert(out?.id === 'prov-out-mask-11', 'output published at bumped version 11')

  // Verify outputIsStale returns false
  const stale = outputIsStale('TRANSLATE_DUB', 11, out)
  assert(stale === false, 'regenerated output at version 11 is not stale')

  // Verify helper getActiveGenerationProvenance works cleanly
  const prov = await getActiveGenerationProvenance(projectId, 'dub.render', project, 11)
  assert(prov.isTtsActive === false && prov.snapshot === 11 && prov.state === 'absent',
    `getActiveGenerationProvenance correctly reports inactive ttsAlign (got: ${JSON.stringify(prov)})`)

  await run('DELETE FROM outputs WHERE project_id = ?', [projectId])
  await run('DELETE FROM projects WHERE id = ?', [projectId])
}

await run('DELETE FROM projects WHERE id IN (?, ?, ?)', ['prov-skip', 'prov-resume', 'prov-out'])
await run("DELETE FROM users WHERE id = 'prov-user'")
fs.rmSync(tmpRoot, { recursive: true, force: true })
if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
