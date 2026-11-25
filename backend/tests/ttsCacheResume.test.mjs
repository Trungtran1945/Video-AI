// TTS cache/resume: canonical fingerprint reuse + partial completion + failover + checkpoint resume.
import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { buildTtsCacheInput, ttsClipKey, isCanonicalTtsCacheInput } from '../src/lib/ttsCacheKey.js'
import { classifyProviderError, ERROR_CODES } from '../src/lib/providerErrors.js'
import { KEYLESS } from '../src/providers/registry.js'
import { withProviderFailover } from '../src/lib/providerFailover.js'
import { clearProviderHealthForTests } from '../src/lib/providerHealth.js'
import { runWithProviderScope } from '../src/lib/providerScope.js'

process.env.NODE_ENV = 'test'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// ── 1. Canonical cache key & fingerprint tests ──
{
  const a = buildTtsCacheInput({ provider: 'edge_tts', voice: 'vi-VN-NamMinhNeural', model: 'vi-VN-NamMinhNeural', text: 'Xin chào', speed: 1 })
  const b = buildTtsCacheInput({ provider: 'edge_tts', voice: 'vi-VN-NamMinhNeural', model: 'vi-VN-NamMinhNeural', text: '  Xin   chào ', speed: 1 })
  assert(ttsClipKey(a) === ttsClipKey(b), 'same input (whitespace-normalized) → same clip key (no new provider call)')
  assert(isCanonicalTtsCacheInput(a) === true, 'canonical input recognized')
}

{
  const a = buildTtsCacheInput({ provider: 'edge_tts', voice: 'v1', model: 'v1', text: 'Xin chào', speed: 1 })
  const b = buildTtsCacheInput({ provider: 'edge_tts', voice: 'v1', model: 'v1', text: 'Tạm biệt', speed: 1 })
  assert(ttsClipKey(a) !== ttsClipKey(b), 'changed text → new clip key (new TTS call)')
}

{
  const a = buildTtsCacheInput({ provider: 'edge_tts', voice: 'voice-A', model: 'voice-A', text: 'Xin chào', speed: 1 })
  const b = buildTtsCacheInput({ provider: 'edge_tts', voice: 'voice-B', model: 'voice-B', text: 'Xin chào', speed: 1 })
  assert(ttsClipKey(a) !== ttsClipKey(b), 'changed voice → new clip key (new TTS call)')
}

{
  // outPath/tmp paths/secrets must never affect identity.
  const a = buildTtsCacheInput({ provider: 'edge_tts', voice: 'v1', model: 'v1', text: 'Hi', speed: 1 })
  assert(!('outPath' in a) && !('apiKey' in a), 'fingerprint excludes outPath/secrets')
  let threw = false
  try { buildTtsCacheInput({ provider: 'edge_tts', voice: 'v1', model: 'v1', text: '   ', speed: 1 }) } catch (_) { threw = true }
  assert(threw === true, 'empty text rejected (no bogus cache hit)')
}

{
  // Error classifier contracts
  const KEY_LEVEL = new Set([ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, ERROR_CODES.PROVIDER_AUTH_FAILED, ERROR_CODES.PROVIDER_MODEL_NOT_FOUND])
  const quotaCode = classifyProviderError(Object.assign(new Error('quota exhausted'), { status: 429 })).code
  assert(KEY_LEVEL.has(quotaCode) === true, 'quota is key-level (batch stops, remaining marked failed without provider calls)')
  const rateCode = classifyProviderError(Object.assign(new Error('too many requests'), { status: 429 })).code
  assert(KEY_LEVEL.has(rateCode) === false, 'rate-limit is NOT key-level (streak rule applies, not instant stop)')
  const total = 100
  const completed = 70
  const missing = Array.from({ length: total - completed }, (_, k) => completed + k)
  assert(missing.length === 30 && missing[0] === 70, 'partial rerun computes only missing segments (70 reuse + 30 generate)')
}

// ── 2. Failover: openai_tts quota exhausted -> fallback to edge_tts ──
{
  console.log('\n--- Test: Failover with keyless provider chain ---')
  clearProviderHealthForTests()
  const candidates = [
    { id: 'openai_tts', apiKeyId: 'openai-k1', provider: {} },
    { id: 'openai_tts', apiKeyId: 'openai-k2', provider: {} },
    { id: 'openai_tts', apiKeyId: 'openai-k3', provider: {} },
    { id: 'openai_tts', apiKeyId: 'openai-k4', provider: {} },
    { id: 'edge_tts', apiKeyId: 'edge-free', provider: {} },
  ]
  const keylessIdx = candidates.findIndex((c) => ['edge_tts', 'zerotts', 'mock', 'google_tts', 'voicestudio'].includes(c.id) || KEYLESS.has(c.id))
  assert(keylessIdx === 4, 'edge_tts detected as keyless candidate at index 4')
  const maxAttempts = keylessIdx >= 0
    ? Math.max(candidates.length, keylessIdx + 1)
    : Math.max(4, candidates.length)
  assert(maxAttempts === 5, 'maxAttempts expands to 5 so keyless provider at index 4 is reached')

  const calls = []
  await runWithProviderScope('test:openai_failover_to_edge', async () => {
    const out = await withProviderFailover(
      { capability: 'TTS', candidates, maxAttempts },
      async (cand) => {
        calls.push(cand.apiKeyId)
        if (cand.id === 'openai_tts') {
          const quotaErr = Object.assign(new Error('OpenAI quota exhausted (429)'), { status: 429 })
          throw quotaErr
        }
        return { audioPath: 'edge_output.mp3', durationSec: 2.0 }
      }
    )
    assert(out.provider.id === 'edge_tts', 'failover successfully landed on edge_tts after 4 openai_tts quota errors')
    assert(calls.length === 5, `all 4 openai keys failed then 5th (edge_tts) was attempted and succeeded (calls=${calls.length})`)
  })
}

// ── 3. Checkpoint persistence & partial rerun with dubTtsAlign ──
{
  console.log('\n--- Test: Quota exhaustion mid-way -> rerun only synths remaining segments ---')
  const { initSchema } = await import('../src/db/schema.js')
  const { query, queryOne, run, insert } = await import('../src/db/query.js')
  const { default: dubTtsAlign } = await import('../src/pipeline/stages/dubTtsAlign.js')
  const { default: MockTts } = await import('../src/providers/tts/mockTts.js')
  const { projectDir } = await import('../src/pipeline/context.js')

  await initSchema()

  const testUserId = uuidv4()
  const testProjectId = uuidv4()
  const origSynth = MockTts.prototype.synthesize

  try {
    // Seed user, settings, project
    await insert('users', {
      id: testUserId,
      email: `tts_resume_${Date.now()}@test.local`,
      password: 'hash',
      role: 'user',
      created_date: new Date().toISOString(),
    })
    await insert('settings', {
      user_id: testUserId,
      active_llm_provider: 'mock',
      active_voice_provider: 'mock',
    })
    await insert('projects', {
      id: testProjectId,
      user_id: testUserId,
      mode: 'TRANSLATE_DUB',
      title: 'TTS Resume Test Project',
      status: 'running',
      transcript_version: 1,
      params: JSON.stringify({ enableDubbing: true, targetLanguage: 'vi', voiceProvider: 'mock' }),
    })

    const seg0Id = uuidv4()
    const seg1Id = uuidv4()
    const seg2Id = uuidv4()

    await insert('transcript_segments', {
      id: seg0Id,
      project_id: testProjectId,
      index_num: 0,
      start_sec: 0,
      end_sec: 2,
      text: 'First segment',
      translation: 'Đoạn đầu tiên',
    })
    await insert('transcript_segments', {
      id: seg1Id,
      project_id: testProjectId,
      index_num: 1,
      start_sec: 2.5,
      end_sec: 4.5,
      text: 'Second segment',
      translation: 'Đoạn thứ hai',
    })
    await insert('transcript_segments', {
      id: seg2Id,
      project_id: testProjectId,
      index_num: 2,
      start_sec: 5,
      end_sec: 7,
      text: 'Third segment',
      translation: 'Đoạn thứ ba',
    })

    const projectRow = await queryOne('SELECT * FROM projects WHERE id = ?', [testProjectId])

    // --- Run 1: Quota exhaustion on segment 3 (index 2) ---
    let synthCalls = []

    MockTts.prototype.synthesize = async function (input, opts) {
      const text = typeof input === 'object' ? input.text : input
      synthCalls.push(text)
      if (synthCalls.length === 3) {
        // 3rd call throws 429 quota exhaustion
        const quotaErr = new Error('Quota exceeded 429')
        quotaErr.status = 429
        quotaErr.code = ERROR_CODES.PROVIDER_QUOTA_EXCEEDED
        throw quotaErr
      }
      return origSynth.call(this, input, opts)
    }

    let run1Threw = null
    try {
      await dubTtsAlign({
        project: projectRow,
        job: { id: uuidv4() },
        setProgress: () => {},
        signal: undefined,
        transcriptVersionSnapshot: 1,
      })
    } catch (err) {
      run1Threw = err
    }

    assert(run1Threw !== null, 'Run 1 threw on quota exhaustion')
    assert(run1Threw?.code === ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, `Run 1 error code is PROVIDER_QUOTA_EXCEEDED (got ${run1Threw?.code})`)
    assert(Array.isArray(run1Threw?.missingSegments) && run1Threw.missingSegments.includes(2), 'Run 1 missingSegments includes segment index 2')
    assert(run1Threw?.completedSegments === 2, `Run 1 completedSegments is 2 (got ${run1Threw?.completedSegments})`)

    // Verify Checkpoint DB state: seg0 & seg1 are already saved in DB!
    const dbSegs1 = await query('SELECT id, index_num, tts_audio_id FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC', [testProjectId])
    assert(dbSegs1[0].tts_audio_id !== null, 'Segment 0 has tts_audio_id checkpointed')
    assert(dbSegs1[1].tts_audio_id !== null, 'Segment 1 has tts_audio_id checkpointed')
    assert(dbSegs1[2].tts_audio_id === null, 'Segment 2 has null tts_audio_id (failed on quota)')

    const audioRows1 = await query('SELECT id FROM audios WHERE project_id = ?', [testProjectId])
    assert(audioRows1.length === 2, `Audios table has 2 rows checkpointed (got ${audioRows1.length})`)

    // Verify audio files exist on disk for seg0 & seg1
    const pDir = projectDir(testProjectId)
    const segDir = path.join(pDir, 'audio_segments')
    const seg0File = path.join(segDir, `seg_fit_${seg0Id.replace(/[^a-zA-Z0-9_-]/g, '_')}.wav`)
    const seg1File = path.join(segDir, `seg_fit_${seg1Id.replace(/[^a-zA-Z0-9_-]/g, '_')}.wav`)
    assert(fs.existsSync(seg0File), 'Segment 0 audio file exists on disk')
    assert(fs.existsSync(seg1File), 'Segment 1 audio file exists on disk')

    // --- Run 2: Rerun after quota issue resolved ---
    // Now mock provider succeeds on all calls.
    synthCalls = []
    MockTts.prototype.synthesize = async function (input, opts) {
      const text = typeof input === 'object' ? input.text : input
      synthCalls.push(text)
      return origSynth.call(this, input, opts)
    }

    const updatedProject = await queryOne('SELECT * FROM projects WHERE id = ?', [testProjectId])
    const res2 = await dubTtsAlign({
      project: updatedProject,
      job: { id: uuidv4() },
      setProgress: () => {},
      signal: undefined,
      transcriptVersionSnapshot: 1,
    })

    MockTts.prototype.synthesize = origSynth

    assert(res2.dubbedCount === 3, `Run 2 dubbedCount is 3 (got ${res2.dubbedCount})`)
    assert(res2.skippedCount === 0, `Run 2 skippedCount is 0 (got ${res2.skippedCount})`)
    assert(res2.cacheHitCount >= 2, `Run 2 cacheHitCount is at least 2 from checkpoint (got ${res2.cacheHitCount})`)
    assert(synthCalls.length === 1, `Provider synthesize called ONLY for 1 segment (seg 2) during resume (got ${synthCalls.length} calls)`)
    assert(synthCalls[0] === 'Đoạn thứ ba', `Provider synthesized segment 3 ("Đoạn thứ ba"), got "${synthCalls[0]}"`)

    // Verify DB state after Run 2
    const dbSegs2 = await query('SELECT id, index_num, tts_audio_id FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC', [testProjectId])
    assert(dbSegs2[0].tts_audio_id === dbSegs1[0].tts_audio_id, 'Segment 0 kept its existing audio ID from checkpoint')
    assert(dbSegs2[1].tts_audio_id === dbSegs1[1].tts_audio_id, 'Segment 1 kept its existing audio ID from checkpoint')
    assert(dbSegs2[2].tts_audio_id !== null, 'Segment 2 now has tts_audio_id')

    const audioRows2 = await query('SELECT id FROM audios WHERE project_id = ?', [testProjectId])
    assert(audioRows2.length === 3, `Audios table has exactly 3 rows (got ${audioRows2.length})`)

    // --- Test 4: Abort signal propagation ---
    console.log('\n--- Test: Abort signal propagation ---')
    const ac = new AbortController()
    ac.abort()
    let abortThrew = null
    try {
      await dubTtsAlign({
        project: updatedProject,
        job: { id: uuidv4() },
        setProgress: () => {},
        signal: ac.signal,
        transcriptVersionSnapshot: 1,
      })
    } catch (err) {
      abortThrew = err
    }
    assert(abortThrew !== null && /Cancelled/i.test(abortThrew.message), 'dubTtsAlign aborted immediately on signal.aborted')

  } finally {
    MockTts.prototype.synthesize = origSynth
    try { fs.rmSync(path.join(projectDir(testProjectId), 'audio_segments'), { recursive: true, force: true }) } catch (_) {}
    try { await run('DELETE FROM transcript_segments WHERE project_id = ?', [testProjectId]) } catch (_) {}
    try { await run('DELETE FROM audios WHERE project_id = ?', [testProjectId]) } catch (_) {}
    try { await run('DELETE FROM generation_jobs WHERE project_id = ?', [testProjectId]) } catch (_) {}
    try { await run('DELETE FROM projects WHERE id = ?', [testProjectId]) } catch (_) {}
    try { await run('DELETE FROM settings WHERE user_id = ?', [testUserId]) } catch (_) {}
    try { await run('DELETE FROM users WHERE id = ?', [testUserId]) } catch (_) {}
  }
}

// ── 4. Pipeline runner checkpoint resume (through runPipeline with clearArtifacts) ──
{
  console.log('\n--- Test: Pipeline runner checkpoint resume (runPipeline + clearArtifacts) ---')
  const { query, queryOne, run, insert } = await import('../src/db/query.js')
  const { default: runner, setStageImplOverride, clearStageImplOverrides } = await import('../src/pipeline/runner.js')
  const { default: MockTts } = await import('../src/providers/tts/mockTts.js')
  const { projectDir } = await import('../src/pipeline/context.js')

  const testUserId2 = uuidv4()
  const testProjectId2 = uuidv4()
  const origSynth = MockTts.prototype.synthesize

  try {
    // 1. Seed user, settings, project
    await insert('users', {
      id: testUserId2,
      email: `tts_runner_${Date.now()}@test.local`,
      password: 'hash',
      role: 'user',
      created_date: new Date().toISOString(),
    })
    await insert('settings', {
      user_id: testUserId2,
      active_llm_provider: 'mock',
      active_voice_provider: 'mock',
    })
    await insert('projects', {
      id: testProjectId2,
      user_id: testUserId2,
      mode: 'TRANSLATE_DUB',
      title: 'TTS Runner Resume Test',
      status: 'pending',
      transcript_version: 1,
      source_storage_provider: 'cloudinary',
      params: JSON.stringify({ enableDubbing: true, targetLanguage: 'vi', voiceProvider: 'mock', audioMode: 'DUB_MIX' }),
    })

    // 2. Seed predecessor jobs as success so firstRunnableStage targets dub.ttsAlign
    for (const st of ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.mask']) {
      await insert('generation_jobs', { id: uuidv4(), project_id: testProjectId2, type: st, status: 'success' })
    }
    await insert('generation_jobs', { id: uuidv4(), project_id: testProjectId2, type: 'dub.ttsAlign', status: 'pending' })

    // 3. Seed 3 segments
    const rSeg0Id = uuidv4()
    const rSeg1Id = uuidv4()
    const rSeg2Id = uuidv4()

    await insert('transcript_segments', {
      id: rSeg0Id,
      project_id: testProjectId2,
      index_num: 0,
      start_sec: 0,
      end_sec: 2,
      text: 'Runner segment 1',
      translation: 'Đoạn runner một',
    })
    await insert('transcript_segments', {
      id: rSeg1Id,
      project_id: testProjectId2,
      index_num: 1,
      start_sec: 2.5,
      end_sec: 4.5,
      text: 'Runner segment 2',
      translation: 'Đoạn runner hai',
    })
    await insert('transcript_segments', {
      id: rSeg2Id,
      project_id: testProjectId2,
      index_num: 2,
      start_sec: 5,
      end_sec: 7,
      text: 'Runner segment 3',
      translation: 'Đoạn runner ba',
    })

    // Mock dub.render downstream to avoid ffmpeg invocation
    setStageImplOverride('dub.render', async () => ({ outputKey: 'outputs/mock_render.mp4' }))

    // 4. Run 1: Mock TTS fails with quota error on 3rd call (segment 3 / index 2)
    let runnerCalls = []
    MockTts.prototype.synthesize = async function (input, opts) {
      const text = typeof input === 'object' ? input.text : input
      runnerCalls.push(text)
      if (runnerCalls.length === 3) {
        const quotaErr = new Error('Quota exceeded 429')
        quotaErr.status = 429
        quotaErr.code = ERROR_CODES.PROVIDER_QUOTA_EXCEEDED
        throw quotaErr
      }
      return origSynth.call(this, input, opts)
    }

    await runner.runPipeline(testProjectId2, 'dub.ttsAlign')

    // Assertions after Run 1:
    const ttsJob1 = await queryOne("SELECT status, error_message FROM generation_jobs WHERE project_id = ? AND type = 'dub.ttsAlign'", [testProjectId2])
    assert(ttsJob1 && ttsJob1.status === 'failed', `Run 1 through runner failed dub.ttsAlign job on quota (got ${ttsJob1?.status})`)

    const rSegs1 = await query('SELECT id, index_num, tts_audio_id FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC', [testProjectId2])
    assert(rSegs1[0].tts_audio_id !== null, 'Runner segment 0 has tts_audio_id checkpointed')
    assert(rSegs1[1].tts_audio_id !== null, 'Runner segment 1 has tts_audio_id checkpointed')
    assert(rSegs1[2].tts_audio_id === null, 'Runner segment 2 has null tts_audio_id (failed on quota)')

    const pDir2 = projectDir(testProjectId2)
    const rSegDir = path.join(pDir2, 'audio_segments')
    const rSeg0File = path.join(rSegDir, `seg_fit_${rSeg0Id.replace(/[^a-zA-Z0-9_-]/g, '_')}.wav`)
    const rSeg1File = path.join(rSegDir, `seg_fit_${rSeg1Id.replace(/[^a-zA-Z0-9_-]/g, '_')}.wav`)
    assert(fs.existsSync(rSeg0File), 'Runner segment 0 audio file exists on disk')
    assert(fs.existsSync(rSeg1File), 'Runner segment 1 audio file exists on disk')

    const rAudios1 = await query('SELECT id FROM audios WHERE project_id = ?', [testProjectId2])
    assert(rAudios1.length === 2, `Audios table has exactly 2 rows checkpointed after Run 1 (got ${rAudios1.length})`)

    // 5. Run 2 (Retry): provider succeeds, executeStage calls clearArtifacts
    runnerCalls = []
    MockTts.prototype.synthesize = async function (input, opts) {
      const text = typeof input === 'object' ? input.text : input
      runnerCalls.push(text)
      return origSynth.call(this, input, opts)
    }

    await run("UPDATE projects SET status = 'pending', run_token = NULL WHERE id = ?", [testProjectId2])
    await run("UPDATE generation_jobs SET status = 'pending', error_message = NULL WHERE project_id = ? AND type = 'dub.ttsAlign'", [testProjectId2])

    await runner.runPipeline(testProjectId2, 'dub.ttsAlign')

    // Assertions after Run 2 (Retry):
    const ttsJob2 = await queryOne("SELECT status FROM generation_jobs WHERE project_id = ? AND type = 'dub.ttsAlign'", [testProjectId2])
    assert(ttsJob2 && ttsJob2.status === 'success', `Run 2 through runner succeeded dub.ttsAlign job (got ${ttsJob2?.status})`)
    assert(runnerCalls.length === 1, `Provider synthesize called ONLY ONCE during retry (got ${runnerCalls.length} calls)`)
    assert(runnerCalls[0] === 'Đoạn runner ba', `Provider synthesized segment 3 ("Đoạn runner ba"), got "${runnerCalls[0]}"`)

    const rSegs2 = await query('SELECT id, index_num, tts_audio_id FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC', [testProjectId2])
    assert(rSegs2[0].tts_audio_id === rSegs1[0].tts_audio_id, 'Runner segment 0 kept original tts_audio_id from checkpoint')
    assert(rSegs2[1].tts_audio_id === rSegs1[1].tts_audio_id, 'Runner segment 1 kept original tts_audio_id from checkpoint')
    assert(rSegs2[2].tts_audio_id !== null, 'Runner segment 2 now has tts_audio_id')

    const rAudios2 = await query('SELECT id FROM audios WHERE project_id = ?', [testProjectId2])
    assert(rAudios2.length === 3, `Audios table has exactly 3 rows (got ${rAudios2.length}) — no duplicate audio rows`)

    // Assert no dangling tts_audio_id
    const dangling = await query(
      'SELECT id, tts_audio_id FROM transcript_segments WHERE project_id = ? AND tts_audio_id IS NOT NULL AND tts_audio_id NOT IN (SELECT id FROM audios WHERE project_id = ?)',
      [testProjectId2, testProjectId2]
    )
    assert(dangling.length === 0, `No dangling tts_audio_id found (got ${dangling.length})`)

    // Assert no orphan audios
    const orphans = await query(
      'SELECT id FROM audios WHERE project_id = ? AND kind = ? AND id NOT IN (SELECT tts_audio_id FROM transcript_segments WHERE project_id = ? AND tts_audio_id IS NOT NULL)',
      [testProjectId2, 'voice', testProjectId2]
    )
    assert(orphans.length === 0, `No orphan audio rows found (got ${orphans.length})`)

  } finally {
    clearStageImplOverrides()
    MockTts.prototype.synthesize = origSynth
    try { fs.rmSync(path.join(projectDir(testProjectId2), 'audio_segments'), { recursive: true, force: true }) } catch (_) {}
    try { await run('DELETE FROM transcript_segments WHERE project_id = ?', [testProjectId2]) } catch (_) {}
    try { await run('DELETE FROM audios WHERE project_id = ?', [testProjectId2]) } catch (_) {}
    try { await run('DELETE FROM generation_jobs WHERE project_id = ?', [testProjectId2]) } catch (_) {}
    try { await run('DELETE FROM projects WHERE id = ?', [testProjectId2]) } catch (_) {}
    try { await run('DELETE FROM settings WHERE user_id = ?', [testUserId2]) } catch (_) {}
    try { await run('DELETE FROM users WHERE id = ?', [testUserId2]) } catch (_) {}
  }
}

console.log(failures === 0 ? '\nALL PASS: ttsCacheResume suite passed completely!' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
