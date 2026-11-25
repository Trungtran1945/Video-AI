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
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne, run } = await import('../src/db/query.js')
const {
  default: runner,
  resolveGenerationSnapshot,
  resolveGenerationProvenance,
  getActiveGenerationProvenance,
  setStageImplOverride,
  clearStageImplOverrides,
} = await import('../src/pipeline/runner.js')
const { default: dubTtsAlign } = await import('../src/pipeline/stages/dubTtsAlign.js')
const { default: dubRender } = await import('../src/pipeline/stages/dubRender.js')
const { createOutput, outputIsStale } = await import('../src/services/outputService.js')

await initSchema()

const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const uid = (base) => `${base}-${runId}`
const testUserId = uid('prov-user')
const createdProjectIds = []
const trackProject = (id) => { createdProjectIds.push(id); return id }

await insert('users', {
  id: testUserId,
  email: `${testUserId}@test.local`,
  password: 'hash',
  role: 'user',
})

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }
const readSrc = (...parts) => fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8')

try {
// ── 1. Stages fail fast without a generation snapshot ──
{
  let err = null
  try {
    await dubTtsAlign({ project: { id: uid('prov-no-snap'), params: '{}' }, job: {}, setProgress: () => {}, signal: undefined, transcriptVersionSnapshot: null })
  } catch (e) { err = e }
  assert(err?.code === 'TRANSCRIPT_SNAPSHOT_MISSING', `dub.ttsAlign rejects a null snapshot (got: ${err?.code || err?.message})`)

  err = null
  try {
    await dubTtsAlign({ project: { id: uid('prov-no-snap'), params: '{}' }, job: {}, setProgress: () => {}, signal: undefined })
  } catch (e) { err = e }
  assert(err?.code === 'TRANSCRIPT_SNAPSHOT_MISSING', 'dub.ttsAlign rejects a missing snapshot')

  err = null
  try {
    await dubRender({ project: { id: uid('prov-no-snap'), params: '{}' }, setProgress: () => {}, signal: undefined })
  } catch (e) { err = e }
  assert(err?.code === 'GENERATION_SNAPSHOT_MISSING', `dub.render rejects a null snapshot (got: ${err?.code || err?.message})`)

  err = null
  try {
    await dubRender({ project: { id: uid('prov-no-snap'), params: '{}' }, setProgress: () => {}, signal: undefined, transcriptVersionSnapshot: 1.5 })
  } catch (e) { err = e }
  assert(err?.code === 'GENERATION_SNAPSHOT_MISSING', 'dub.render rejects a non-integer snapshot')
}

// ── 2. dub.ttsAlign publishes the snapshot it synthesized from (skip path) ──
{
  const projectId = trackProject(uid('prov-skip'))
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    mode: 'TRANSLATE_DUB',
    title: 'skip path',
    params: JSON.stringify({ enableDubbing: false }),
    transcript_version: 5,
  })
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  const result = await dubTtsAlign({
    project,
    job: { id: uid('prov-skip-job') },
    setProgress: () => {},
    signal: undefined,
    transcriptVersionSnapshot: 5,
  })
  assert(result?.skipped === true && result?.transcriptVersionSnapshot === 5,
    `skipped ttsAlign still returns its snapshot (got: ${JSON.stringify(result)})`)

  await run('DELETE FROM projects WHERE id = ?', [projectId])
}

// ── 3. Resume resolution: frozen snapshot vs current revision ──
{
  const projectId = trackProject(uid('prov-resume'))
  const jobId = uid('prov-job-legacy')
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
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
    id: jobId,
    project_id: projectId,
    type: 'dub.ttsAlign',
    status: 'success',
    result: JSON.stringify({ dubbedCount: 3 }),
  })
  snapshot = await resolveGenerationSnapshot(projectId, 'dub.render', project)
  assert(snapshot === 9, `legacy job result without snapshot → capture current (got ${snapshot})`)

  // Successful ttsAlign with a frozen snapshot → render-only resume reuses it.
  await run('UPDATE generation_jobs SET result = ? WHERE id = ?', [JSON.stringify({ dubbedCount: 3, transcriptVersionSnapshot: 7 }), jobId])
  snapshot = await resolveGenerationSnapshot(projectId, 'dub.render', project)
  assert(snapshot === 7, `render-only resume reuses the frozen snapshot (got ${snapshot})`)

  // Job not successful → never trust its result.
  await run('UPDATE generation_jobs SET status = ? WHERE id = ?', ['retry', jobId])
  snapshot = await resolveGenerationSnapshot(projectId, 'dub.render', project)
  assert(snapshot === 9, `unsuccessful ttsAlign result is ignored (got ${snapshot})`)
  await run('UPDATE generation_jobs SET status = ? WHERE id = ?', ['success', jobId])

  // Any resume that re-runs ttsAlign captures current, even with a frozen job.
  snapshot = await resolveGenerationSnapshot(projectId, 'dub.stt', project)
  assert(snapshot === 9, `ttsAlign re-run captures current over the frozen snapshot (got ${snapshot})`)
  snapshot = await resolveGenerationSnapshot(projectId, null, project)
  assert(snapshot === 9, `fresh run captures current (got ${snapshot})`)

  await run('DELETE FROM generation_jobs WHERE project_id = ?', [projectId])
  await run('DELETE FROM projects WHERE id = ?', [projectId])
}

// ── 4. Output provenance matches the generation snapshot ──
{
  const projectId = trackProject(uid('prov-out'))
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    mode: 'TRANSLATE_DUB',
    title: 'output provenance',
    status: 'completed',
    transcript_version: 9,
  })
  await insert('generation_jobs', {
    id: uid('prov-out-tts-job'),
    project_id: projectId,
    type: 'dub.ttsAlign',
    status: 'success',
    result: JSON.stringify({ transcriptVersionSnapshot: 7 }),
  })

  const outId7 = uid('prov-out-7')
  const outputAtSnapshot = await createOutput({
    id: outId7,
    projectId,
    storageKey: `projects/${projectId}/final.mp4`,
    durationSec: 1,
    transcriptVersion: 7,
  })
  assert(outputAtSnapshot?.id === outId7, 'output at the generation snapshot is published')

  let mismatch = null
  try {
    await createOutput({
      id: uid('prov-out-9'),
      projectId,
      storageKey: `projects/${projectId}/final-9.mp4`,
      durationSec: 1,
      transcriptVersion: 9,
    })
  } catch (e) { mismatch = e }
  assert(mismatch && /snapshot/.test(mismatch.message),
    `output at the CURRENT revision is rejected (got: ${mismatch?.message})`)

  // Legacy generation (job result without snapshot) keeps publishing.
  await run('UPDATE generation_jobs SET result = ? WHERE project_id = ? AND type = ?', [JSON.stringify({ dubbedCount: 2 }), projectId, 'dub.ttsAlign'])
  const outIdLegacy = uid('prov-out-legacy')
  const legacy = await createOutput({
    id: outIdLegacy,
    projectId,
    storageKey: `projects/${projectId}/final-legacy.mp4`,
    durationSec: 1,
    transcriptVersion: 9,
  })
  assert(legacy?.id === outIdLegacy, 'legacy generation without a persisted snapshot still publishes')

  await run('DELETE FROM outputs WHERE project_id = ?', [projectId])
  await run('DELETE FROM generation_jobs WHERE project_id = ?', [projectId])
  await run('DELETE FROM projects WHERE id = ?', [projectId])
}

// ── 4b. Strict snapshot semantics: LEGACY_GENERATION falls back, a declared
//        but unusable snapshot never silently becomes the current revision ──
{
  const projectId = trackProject(uid('prov-strict'))
  const strictJobId = uid('prov-strict-job')
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    mode: 'TRANSLATE_DUB',
    title: 'strict snapshot',
    params: JSON.stringify({}),
    transcript_version: 12,
  })
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  await insert('generation_jobs', {
    id: strictJobId,
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
    [JSON.stringify({ dubbedCount: 1, transcriptVersionSnapshot: 2.5 }), strictJobId])
  err = null
  try { await resolveGenerationSnapshot(projectId, 'dub.render', project) } catch (e) { err = e }
  assert(err !== null, 'a non-integer persisted snapshot refuses a silent fallback')

  await run('UPDATE generation_jobs SET result = ? WHERE id = ?',
    [JSON.stringify({ dubbedCount: 1 }), strictJobId])
  const legacy = await resolveGenerationSnapshot(projectId, 'dub.render', project)
  assert(legacy === 12, `LEGACY_GENERATION (no snapshot key at all) still falls back to current (got ${legacy})`)

  await run('UPDATE generation_jobs SET result = ? WHERE id = ?',
    [JSON.stringify({ dubbedCount: 1, transcriptVersionSnapshot: 11 }), strictJobId])
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
  const projectId = trackProject(uid('prov-dub-off'))
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    mode: 'TRANSLATE_DUB',
    title: 'dubbing disabled with stale tts job',
    status: 'running',
    params: JSON.stringify({ enableDubbing: false }),
    transcript_version: 11,
  })
  // Stale ttsAlign job from earlier when dubbing was on
  await insert('generation_jobs', {
    id: uid('prov-stale-tts-job'),
    project_id: projectId,
    type: 'dub.ttsAlign',
    status: 'success',
    result: JSON.stringify({ transcriptVersionSnapshot: 10 }),
  })

  // createOutput at version 11 must succeed (not throw mismatch)
  let err = null
  let out = null
  const outIdDubOff = uid('prov-out-dub-off')
  try {
    out = await createOutput({
      id: outIdDubOff,
      projectId,
      storageKey: `projects/${projectId}/final.mp4`,
      durationSec: 1,
      transcriptVersion: 11,
    })
  } catch (e) {
    err = e
  }
  assert(!err, `dubbing disabled does not throw mismatch on stale ttsAlign job (err: ${err?.message})`)
  assert(out?.id === outIdDubOff, 'output published successfully when dubbing is disabled')

  // Also test with audioMode = 'ORIGINAL_ONLY'
  await run('UPDATE projects SET params = ? WHERE id = ?', [JSON.stringify({ audioMode: 'ORIGINAL_ONLY' }), projectId])
  err = null
  out = null
  const outIdOrigOnly = uid('prov-out-orig-only')
  try {
    out = await createOutput({
      id: outIdOrigOnly,
      projectId,
      storageKey: `projects/${projectId}/final-orig.mp4`,
      durationSec: 1,
      transcriptVersion: 11,
    })
  } catch (e) {
    err = e
  }
  assert(!err, `audioMode=ORIGINAL_ONLY does not throw mismatch on stale ttsAlign job (err: ${err?.message})`)
  assert(out?.id === outIdOrigOnly, 'output published successfully with audioMode=ORIGINAL_ONLY')

  await run('DELETE FROM outputs WHERE project_id = ?', [projectId])
  await run('DELETE FROM generation_jobs WHERE project_id = ?', [projectId])
  await run('DELETE FROM projects WHERE id = ?', [projectId])
}

// ── 6b. enableDubbing=true + audioMode: ORIGINAL_ONLY does not throw, DUB_MIX throws ──
{
  const projectId = trackProject(uid('prov-dub-mix-check'))
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    mode: 'TRANSLATE_DUB',
    title: 'audioMode mismatch checks',
    status: 'running',
    params: JSON.stringify({ enableDubbing: true, audioMode: 'ORIGINAL_ONLY' }),
    transcript_version: 11,
  })
  // Stale ttsAlign job snapshot 10
  await insert('generation_jobs', {
    id: uid('prov-job-snap-10'),
    project_id: projectId,
    type: 'dub.ttsAlign',
    status: 'success',
    result: JSON.stringify({ transcriptVersionSnapshot: 10 }),
  })

  // 1. ORIGINAL_ONLY with enableDubbing:true + snapshot 10 + version 11 -> createOutput does NOT throw
  let err = null
  let out = null
  const outIdOrig11 = uid('prov-out-orig-only-11')
  try {
    const params = { enableDubbing: true, audioMode: 'ORIGINAL_ONLY' }
    out = await createOutput({
      id: outIdOrig11,
      projectId,
      storageKey: `projects/${projectId}/final-orig.mp4`,
      durationSec: 1,
      transcriptVersion: 11,
      generationSnapshot: 11,
      isTtsActive: params.enableDubbing && params.audioMode !== 'ORIGINAL_ONLY',
    })
  } catch (e) {
    err = e
  }
  assert(!err, `enableDubbing=true + ORIGINAL_ONLY does not throw mismatch on stale ttsAlign job (err: ${err?.message})`)
  assert(out?.id === outIdOrig11, 'output published with enableDubbing=true + ORIGINAL_ONLY')

  // 2. DUB_MIX with enableDubbing:true + snapshot 10 + version 11 -> createOutput STILL throws
  await run('UPDATE projects SET params = ? WHERE id = ?', [JSON.stringify({ enableDubbing: true, audioMode: 'DUB_MIX' }), projectId])
  let mismatchErr = null
  try {
    const params = { enableDubbing: true, audioMode: 'DUB_MIX' }
    await createOutput({
      id: uid('prov-out-dub-mix-11'),
      projectId,
      storageKey: `projects/${projectId}/final-dub-mix.mp4`,
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
  const projectId = trackProject(uid('prov-mask-regen'))
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
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
  const outIdMask11 = uid('prov-out-mask-11')
  const out = await createOutput({
    id: outIdMask11,
    projectId,
    storageKey: `projects/${projectId}/final-11.mp4`,
    durationSec: 1,
    transcriptVersion: snapshot,
    generationSnapshot: snapshot,
    isTtsActive: false,
  })
  assert(out?.id === outIdMask11, 'output published at bumped version 11')

  // Verify outputIsStale returns false
  const stale = outputIsStale('TRANSLATE_DUB', 11, out)
  assert(stale === false, 'regenerated output at version 11 is not stale')

  // Verify helper getActiveGenerationProvenance works cleanly
  const prov = await getActiveGenerationProvenance(projectId, 'dub.render', project, 11)
  assert(prov.isTtsActive === false && prov.snapshot === 11 && prov.state === 'absent' && prov.provenanceRelaxed === false,
    `getActiveGenerationProvenance correctly reports inactive ttsAlign without relaxation (got: ${JSON.stringify(prov)})`)

  await run('DELETE FROM outputs WHERE project_id = ?', [projectId])
  await run('DELETE FROM projects WHERE id = ?', [projectId])
}

// ── 8. Strict provenance invariant when dubbing is active normally ──
{
  const projectId = trackProject(uid('prov-strict-active'))
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    mode: 'TRANSLATE_DUB',
    title: 'strict active dubbing mismatch & corrupt guard',
    status: 'pending',
    source_storage_provider: 'cloudinary',
    source_video_key: 'uploads/mock-src.mp4',
    params: JSON.stringify({ enableDubbing: true, audioMode: 'DUB_MIX' }),
    transcript_version: 11,
  })
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  const ttsJobId = uid('prov-strict-tts')
  await insert('generation_jobs', {
    id: ttsJobId,
    project_id: projectId,
    type: 'dub.ttsAlign',
    status: 'success',
    result: JSON.stringify({ transcriptVersionSnapshot: 10 }),
  })

  // 8a. Resuming dub.render with frozen snapshot 10 while current is 11 is NOT relaxed and uses 10
  const prov = await resolveGenerationProvenance(projectId, 'dub.render', project)
  assert(
    prov.state === 'frozen' && prov.snapshot === 10 && prov.provenanceRelaxed === false && prov.provenanceRelaxedReason === null,
    `frozen snapshot 10 is NOT relaxed when dubbing is active (got: ${JSON.stringify(prov)})`
  )

  // 8b. Publishing output at current revision 11 while frozen snapshot is 10 MUST throw
  let mismatchErr = null
  try {
    await createOutput({
      id: uid('prov-strict-out-mismatch'),
      projectId,
      storageKey: `projects/${projectId}/final-11.mp4`,
      durationSec: 1,
      transcriptVersion: 11,
    })
  } catch (e) { mismatchErr = e }
  assert(mismatchErr && /snapshot 10/.test(mismatchErr.message),
    `active dubbing real mismatch (11 vs frozen 10) still throws in createOutput (got: ${mismatchErr?.message})`)

  // 8c. Corrupt snapshot MUST throw in both resolveGenerationProvenance AND createOutput
  await run('UPDATE generation_jobs SET result = ? WHERE id = ?',
    [JSON.stringify({ transcriptVersionSnapshot: 'corrupt-val' }), ttsJobId])
  let corruptRunnerErr = null
  try { await resolveGenerationProvenance(projectId, 'dub.render', project) } catch (e) { corruptRunnerErr = e }
  assert(corruptRunnerErr && corruptRunnerErr.message.includes('GenerationProvenance'),
    `corrupt snapshot still throws in resolveGenerationProvenance (got: ${corruptRunnerErr?.message})`)

  let corruptOutErr = null
  try {
    await createOutput({
      id: uid('prov-strict-out-corrupt'),
      projectId,
      storageKey: `projects/${projectId}/final-corrupt.mp4`,
      durationSec: 1,
      transcriptVersion: 11,
    })
  } catch (e) { corruptOutErr = e }
  assert(corruptOutErr && /corrupt/i.test(corruptOutErr.message),
    `corrupt snapshot also throws in createOutput (got: ${corruptOutErr?.message})`)

  // 8d. Normal run starting at dub.ttsAlign is NOT provenance-relaxed
  for (const st of ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.mask']) {
    await insert('generation_jobs', { id: uid(`prov-pre-${st}`), project_id: projectId, type: st, status: 'success' })
  }
  await run("UPDATE generation_jobs SET status = 'pending', result = NULL WHERE id = ?", [ttsJobId])
  const audioId = uid('prov-audio-normal')
  await insert('audios', { id: audioId, project_id: projectId, kind: 'voice', duration_sec: 1.2, provider: 'mock' })
  await insert('transcript_segments', {
    id: uid('prov-seg-normal'),
    project_id: projectId,
    index_num: 0,
    start_sec: 0,
    end_sec: 2,
    text: 'Hello normal dub',
    translation: 'Xin chào bình thường',
    tts_audio_id: audioId,
  })
  const ttsProv = await getActiveGenerationProvenance(projectId, 'dub.ttsAlign', project, 11)
  assert(ttsProv.isTtsActive === true && ttsProv.ttsWillRun === true && ttsProv.provenanceRelaxed === false,
    `starting at dub.ttsAlign is NOT marked provenanceRelaxed (got: ${JSON.stringify(ttsProv)})`)

  let renderCtxSawRelaxed = null
  setStageImplOverride('dub.ttsAlign', async (ctx) => ({ dubbedCount: 1, transcriptVersionSnapshot: ctx.transcriptVersionSnapshot }))
  setStageImplOverride('dub.render', async (ctx) => {
    renderCtxSawRelaxed = ctx.provenanceRelaxed
    return { outputKey: `projects/${projectId}/final-normal.mp4`, dubbedAudio: true }
  })
  await runner.runPipeline(projectId, 'dub.ttsAlign')
  clearStageImplOverrides()

  const normalRenderJob = await queryOne(
    "SELECT status, payload, result FROM generation_jobs WHERE project_id = ? AND type = 'dub.render'",
    [projectId]
  )
  const normalRenderResult = JSON.parse(normalRenderJob?.result || '{}')
  const normalRenderPayload = JSON.parse(normalRenderJob?.payload || '{}')
  assert(
    normalRenderJob?.status === 'success'
    && renderCtxSawRelaxed === false
    && normalRenderResult.provenanceRelaxed === undefined
    && normalRenderPayload.provenanceRelaxed === undefined,
    `normal dubbing pipeline run leaves provenanceRelaxed unset in dub.render job.result (got: ${normalRenderJob?.result})`
  )

  await run('DELETE FROM outputs WHERE project_id = ?', [projectId])
  await run('DELETE FROM transcript_segments WHERE project_id = ?', [projectId])
  await run('DELETE FROM audios WHERE project_id = ?', [projectId])
  await run('DELETE FROM generation_jobs WHERE project_id = ?', [projectId])
  await run('DELETE FROM projects WHERE id = ?', [projectId])
}

// ── 9. Absent & legacy fallback records provenanceRelaxed=true + reason in job.result & logs ──
{
  // 9a. Direct provenance check + structured log when resuming dub.render with absent snapshot
  const projectId = trackProject(uid('prov-relaxed-absent'))
  await insert('projects', {
    id: projectId,
    user_id: testUserId,
    mode: 'TRANSLATE_DUB',
    title: 'absent snapshot relaxation',
    status: 'pending',
    source_storage_provider: 'cloudinary',
    source_video_key: 'uploads/mock-absent.mp4',
    params: JSON.stringify({ enableDubbing: true, audioMode: 'DUB_MIX' }),
    transcript_version: 5,
  })
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])

  const capturedWarns = []
  const origWarn = console.warn
  console.warn = (...args) => { capturedWarns.push(args.join(' ')) }
  let absentProv
  try {
    absentProv = await resolveGenerationProvenance(projectId, 'dub.render', project)
  } finally {
    console.warn = origWarn
  }
  assert(
    absentProv?.state === 'absent'
    && absentProv?.snapshot === 5
    && absentProv?.isTtsActive === true
    && absentProv?.ttsWillRun === false
    && absentProv?.provenanceRelaxed === true
    && typeof absentProv?.provenanceRelaxedReason === 'string'
    && absentProv.provenanceRelaxedReason.includes('NO_FROZEN_SNAPSHOT'),
    `absent snapshot fallback returns provenanceRelaxed=true + reason (got: ${JSON.stringify(absentProv)})`
  )
  assert(
    capturedWarns.some((w) => w.includes('[GenerationProvenance]') && w.includes('provenanceRelaxed=true') && w.includes('state=absent')),
    `absent fallback emits structured [GenerationProvenance] warning (logs: ${JSON.stringify(capturedWarns)})`
  )

  // 9b. End-to-end runPipeline on dub.render with dub.ttsAlign lacking frozen snapshot (state=absent via completed job without snapshot)
  for (const st of ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.mask']) {
    await insert('generation_jobs', { id: uid(`prov-abs-${st}`), project_id: projectId, type: st, status: 'success' })
  }
  await insert('generation_jobs', {
    id: uid('prov-abs-tts'),
    project_id: projectId,
    type: 'dub.ttsAlign',
    status: 'completed',
    result: null,
  })
  const audioId = uid('prov-abs-audio')
  await insert('audios', { id: audioId, project_id: projectId, kind: 'voice', duration_sec: 1.0, provider: 'mock' })
  await insert('transcript_segments', {
    id: uid('prov-abs-seg'),
    project_id: projectId,
    index_num: 0,
    start_sec: 0,
    end_sec: 2,
    text: 'Absent snapshot test',
    translation: 'Kiểm tra fallback thiếu snapshot',
    tts_audio_id: audioId,
  })

  const pipelineWarns = []
  console.warn = (...args) => { pipelineWarns.push(args.join(' ')) }
  let stageCtxSnapshot = null
  let stageCtxRelaxed = null
  let stageCtxReason = null
  const outIdAbsent = uid('prov-out-absent-5')
  setStageImplOverride('dub.render', async (ctx) => {
    stageCtxSnapshot = ctx.transcriptVersionSnapshot
    stageCtxRelaxed = ctx.provenanceRelaxed
    stageCtxReason = ctx.provenanceRelaxedReason
    await createOutput({
      id: outIdAbsent,
      projectId,
      storageKey: `projects/${projectId}/final-absent.mp4`,
      durationSec: 1,
      transcriptVersion: ctx.transcriptVersionSnapshot,
      generationSnapshot: ctx.transcriptVersionSnapshot,
      isTtsActive: true,
      runToken: ctx.runToken,
    })
    return { outputKey: `projects/${projectId}/final-absent.mp4`, dubbedAudio: true }
  })
  try {
    await runner.runPipeline(projectId, 'dub.render')
  } finally {
    clearStageImplOverrides()
    console.warn = origWarn
  }

  const absProject = await queryOne('SELECT status FROM projects WHERE id = ?', [projectId])
  const absRenderJob = await queryOne(
    "SELECT status, payload, result FROM generation_jobs WHERE project_id = ? AND type = 'dub.render'",
    [projectId]
  )
  const absResult = JSON.parse(absRenderJob?.result || '{}')
  const absPayload = JSON.parse(absRenderJob?.payload || '{}')
  const absOutput = await queryOne('SELECT id, transcript_version FROM outputs WHERE id = ?', [outIdAbsent])

  assert(absProject?.status === 'completed' && absRenderJob?.status === 'success',
    `absent-snapshot fallback pipeline completes successfully (project=${absProject?.status}, job=${absRenderJob?.status})`)
  assert(stageCtxSnapshot === 5 && stageCtxRelaxed === true && typeof stageCtxReason === 'string' && stageCtxReason.includes('NO_FROZEN_SNAPSHOT'),
    `runner passes provenanceRelaxed=true and reason into stage ctx (snapshot=${stageCtxSnapshot}, relaxed=${stageCtxRelaxed})`)
  assert(absOutput?.transcript_version === 5, `output published at fallback snapshot 5 (got ${absOutput?.transcript_version})`)
  assert(
    absResult.provenanceRelaxed === true
    && typeof absResult.provenanceRelaxedReason === 'string'
    && absResult.provenanceRelaxedReason.includes('NO_FROZEN_SNAPSHOT')
    && absResult.provenanceState === 'absent',
    `persisted dub.render job.result records provenanceRelaxed=true + reason + state (got: ${absRenderJob?.result})`
  )
  assert(absPayload.provenanceRelaxed === true && absPayload.provenanceState === 'absent',
    `dub.render diagnostic payload records provenanceRelaxed=true (got: ${absRenderJob?.payload})`)
  assert(
    pipelineWarns.some((w) => w.includes('[OutputProvenance]') && w.includes('provenanceRelaxed=true') && w.includes('state=absent')),
    `outputService emits structured [OutputProvenance] relaxation log`
  )

  // 9c. Consistent handling for state=legacy (ttsAlign status='success' without transcriptVersionSnapshot key)
  await run("UPDATE projects SET status = 'pending', run_token = NULL, transcript_version = 6 WHERE id = ?", [projectId])
  await run("UPDATE generation_jobs SET status = 'success', result = ? WHERE project_id = ? AND type = 'dub.ttsAlign'",
    [JSON.stringify({ dubbedCount: 1 }), projectId])
  await run("UPDATE generation_jobs SET status = 'pending', result = NULL, payload = NULL WHERE project_id = ? AND type = 'dub.render'",
    [projectId])

  let legacyCtxSawRelaxed = null
  setStageImplOverride('dub.render', async (ctx) => {
    legacyCtxSawRelaxed = ctx.provenanceRelaxed
    return {
      outputKey: `projects/${projectId}/final-legacy.mp4`,
      dubbedAudio: true,
    }
  })
  try {
    await runner.runPipeline(projectId, 'dub.render')
  } finally {
    clearStageImplOverrides()
  }

  const legacyRenderJob = await queryOne(
    "SELECT status, result FROM generation_jobs WHERE project_id = ? AND type = 'dub.render'",
    [projectId]
  )
  const legacyResult = JSON.parse(legacyRenderJob?.result || '{}')
  assert(
    legacyRenderJob?.status === 'success'
    && legacyCtxSawRelaxed === true
    && legacyResult.provenanceRelaxed === true
    && typeof legacyResult.provenanceRelaxedReason === 'string'
    && legacyResult.provenanceRelaxedReason.includes('LEGACY_GENERATION')
    && legacyResult.provenanceState === 'legacy',
    `legacy ttsAlign fallback consistently records provenanceRelaxed=true + LEGACY_GENERATION reason in job.result (got: ${legacyRenderJob?.result})`
  )

  await run('DELETE FROM outputs WHERE project_id = ?', [projectId])
  await run('DELETE FROM transcript_segments WHERE project_id = ?', [projectId])
  await run('DELETE FROM audios WHERE project_id = ?', [projectId])
  await run('DELETE FROM generation_jobs WHERE project_id = ?', [projectId])
  await run('DELETE FROM projects WHERE id = ?', [projectId])
}

} finally {
  clearStageImplOverrides()
  for (const pid of createdProjectIds) {
    try { await run('DELETE FROM outputs WHERE project_id = ?', [pid]) } catch (_) {}
    try { await run('DELETE FROM transcript_segments WHERE project_id = ?', [pid]) } catch (_) {}
    try { await run('DELETE FROM audios WHERE project_id = ?', [pid]) } catch (_) {}
    try { await run('DELETE FROM generation_jobs WHERE project_id = ?', [pid]) } catch (_) {}
    try { await run('DELETE FROM projects WHERE id = ?', [pid]) } catch (_) {}
  }
  try { await run('DELETE FROM users WHERE id = ?', [testUserId]) } catch (_) {}
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
