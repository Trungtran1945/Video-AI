// End-to-end integration test for ZeroTTS local service in Video-AI
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ZeroTts } from '../src/providers/tts/zeroTts.js'
import { run } from '../src/db/query.js'
import '../src/db/schema.js'
import { callProvider } from '../src/lib/callProvider.js'
import { buildTtsCacheInput, ttsClipKey } from '../src/lib/ttsCacheKey.js'
import { withProviderFailover } from '../src/lib/providerFailover.js'
import { runWithProviderScope } from '../src/lib/providerScope.js'
import { clearProviderHealthForTests } from '../src/lib/providerHealth.js'
import { fitSegment } from '../src/pipeline/forcedAlignService.js'
import { applyTempoAudio, probe } from '../src/media/mediaService.js'

let failures = 0
const assert = (c, m) => {
  if (c) console.log('PASS:', m)
  else {
    failures++
    console.error('FAIL:', m)
  }
}

const TEST_PORT = 5007
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`
const tmpDir = path.resolve('storage/tmp/zerotts_e2e')
fs.mkdirSync(tmpDir, { recursive: true })

console.log('=== Starting ZeroTTS Local Integration Test ===')

// 1. Start ZeroTTS Python service in background
console.log(`[1] Launching Python ZeroTTS service on port ${TEST_PORT}...`)
const pyProcess = spawn('python', [
  'scripts/zerotts_service.py',
  '--port', String(TEST_PORT),
  '--threads', '4',
  '--concurrency', '1',
], {
  cwd: path.resolve('.'),
  stdio: ['ignore', 'pipe', 'pipe'],
})

pyProcess.stderr.on('data', (d) => {
  // console.error('[py stderr]', d.toString())
})
pyProcess.stdout.on('data', (d) => {
  // console.log('[py stdout]', d.toString())
})

// Wait for service to be healthy (up to 60s)
async function waitForHealth(maxWaitSec = 60) {
  const start = Date.now()
  while (Date.now() - start < maxWaitSec * 1000) {
    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        const body = await res.json()
        if (body.status === 'ok' && body.model_loaded) return body
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`ZeroTTS service failed to become ready after ${maxWaitSec}s`)
}

let healthData = null
try {
  healthData = await waitForHealth(60)
  assert(healthData.status === 'ok', 'ZeroTTS service started and reported status="ok"')
  assert(healthData.model_loaded === true, 'Model is loaded in memory')
  assert(Array.isArray(healthData.voices) && healthData.voices.includes('maichi'), 'Available voices include "maichi"')
  assert(healthData.concurrency === 1, 'Concurrency limit is set to 1')
  console.log(`[2] ZeroTTS ready in ${healthData.load_time_sec}s with voices: ${healthData.voices.join(', ')}`)
} catch (err) {
  console.error('FATAL: Could not start ZeroTTS service:', err.message)
  pyProcess.kill()
  process.exit(1)
}

try {
  // 2. Instantiate ZeroTts provider pointing to test port
  const zeroTts = new ZeroTts()
  zeroTts.baseUrl = BASE_URL
  zeroTts.voice = 'maichi'

  // 3. Synthesize first Vietnamese sentence
  const sentence1 = 'Xin chào, đây là bài kiểm tra tích hợp ZeroTTS vào hệ thống Video AI.'
  const out1 = path.join(tmpDir, 'test_sentence_1.wav')
  console.log('[3] Synthesizing sentence 1...')
  const res1 = await zeroTts.synthesize({ text: sentence1, outPath: out1 })

  assert(fs.existsSync(out1), 'Audio file 1 exists on disk')
  assert(res1.provider === 'zerotts', 'Provider metadata is "zerotts"')
  assert(res1.durationSec > 0.5, `Duration is > 0.5s (got ${res1.durationSec}s)`)
  const probe1 = await probe(out1)
  assert(probe1.durationSec > 0.5, `ffprobe duration matches synthesized duration (probe=${probe1.durationSec}s)`)
  console.log(`[3] Generated sentence 1: ${res1.durationSec}s`)

  // Check server state
  const healthMid = await (await fetch(`${BASE_URL}/health`)).json()
  assert(healthMid.synthesize_count === 1, 'Server synthesize_count incremented to 1')

  // 4. Test cache hit on second run with callProvider
  console.log('[4] Testing callProvider caching...')
  await run('DELETE FROM provider_cache WHERE provider = ?', ['zerotts'])
  const canonical1 = buildTtsCacheInput({ provider: 'zerotts', voice: 'maichi', model: 'zerotts', text: sentence1, speed: 1 })
  const clipKey = ttsClipKey(canonical1)
  assert(typeof clipKey === 'string' && clipKey.length === 64, 'Generated 64-char sha256 clip key')

  // First call through callProvider
  const callRes1 = await callProvider({
    provider: 'zerotts',
    type: 'tts',
    model: 'zerotts',
    input: canonical1,
    fn: () => zeroTts.synthesize({ text: sentence1, outPath: out1, speed: 1 }),
  })
  assert(callRes1 && callRes1.durationSec > 0.5, 'callProvider returned initial result')

  // Second call through callProvider with identical input -> should hit cache!
  const countBefore = (await (await fetch(`${BASE_URL}/health`)).json()).synthesize_count
  const callRes2 = await callProvider({
    provider: 'zerotts',
    type: 'tts',
    model: 'zerotts',
    input: canonical1,
    fn: () => {
      throw new Error('Provider should NOT be called on cache hit!')
    },
  })
  assert(callRes2.durationSec === callRes1.durationSec, 'callProvider cache hit returns identical duration')
  const countAfter = (await (await fetch(`${BASE_URL}/health`)).json()).synthesize_count
  assert(countAfter === countBefore, 'ZeroTTS server was not called again on cache hit')
  console.log('[4] Cache hit verified successfully!')

  // 5. Synthesize second segment (sequential test, verify no model reload)
  console.log('[5] Synthesizing sentence 2 (multi-segment test)...')
  const sentence2 = 'Câu thứ hai kiểm tra suy luận liên tục mà không nạp lại mô hình.'
  const out2 = path.join(tmpDir, 'test_sentence_2.wav')
  const res2 = await zeroTts.synthesize({ text: sentence2, outPath: out2 })
  assert(fs.existsSync(out2), 'Audio file 2 exists on disk')
  assert(res2.durationSec > 0.5, `Sentence 2 duration > 0.5s (got ${res2.durationSec}s)`)

  const healthAfter2 = await (await fetch(`${BASE_URL}/health`)).json()
  assert(healthAfter2.synthesize_count === 3, `Server synthesize_count is now 3 (got ${healthAfter2.synthesize_count})`)
  assert(healthAfter2.load_time_sec === healthData.load_time_sec, 'Model load time is unchanged (model was loaded exactly ONCE)')

  // 6. Test forced alignment flow (fitSegment + applyTempoAudio)
  console.log('[6] Testing forced alignment and tempo fitting...')
  const targetSlotSec = 3.0
  const fit = fitSegment(res1.durationSec, targetSlotSec, { roomDur: 3.5 })
  assert(Number.isFinite(fit.tempo) && fit.tempo > 0, `fitSegment calculated tempo: ${fit.tempo}`)

  const outFitted = path.join(tmpDir, 'test_fitted.wav')
  await applyTempoAudio(out1, outFitted, {
    tempo: fit.tempo,
    padBeforeSec: fit.padBeforeSec,
    padAfterSec: fit.padAfterSec,
  })
  assert(fs.existsSync(outFitted), 'Fitted audio file created')
  const fittedProbe = await probe(outFitted)
  assert(fittedProbe.durationSec > 0, `Fitted audio duration is valid: ${fittedProbe.durationSec}s`)
  console.log(`[6] Forced alignment successful: fitted duration=${fittedProbe.durationSec}s`)

  // 7. Test MP3 output conversion handling
  console.log('[7] Testing MP3 target output conversion...')
  const outMp3 = path.join(tmpDir, 'test_audio.mp3')
  const resMp3 = await zeroTts.synthesize({ text: 'Kiểm tra ghi định dạng MP3.', outPath: outMp3 })
  assert(fs.existsSync(outMp3), 'MP3 output file created')
  assert(resMp3.audioPath === outMp3, 'Returned audioPath is MP3')
  const mp3Probe = await probe(outMp3)
  assert(mp3Probe.durationSec > 0, `MP3 audio probe valid: ${mp3Probe.durationSec}s, format=${mp3Probe.formatName}`)

  // 8. Test redub/resume semantics: existing clip is reused without synthesis
  console.log('[8] Testing redub/resume clip reuse...')
  const clipPathResume = path.join(tmpDir, 'clip_resume_test.mp3')
  fs.copyFileSync(outMp3, clipPathResume)
  assert(fs.existsSync(clipPathResume), 'Simulated pre-existing clip exists')
  const resumeProbe = await probe(clipPathResume)
  assert(resumeProbe.durationSec > 0.1, 'Pre-existing clip is valid for resume')

  // 9. Stop ZeroTTS service and verify failover
  console.log('[9] Stopping ZeroTTS service and testing failover...')
  pyProcess.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 1000))

  clearProviderHealthForTests()
  let failoverSucceeded = false
  await runWithProviderScope('test:e2e-failover', async () => {
    const candidates = [
      { id: 'zerotts', apiKeyId: null, provider: zeroTts },
      {
        id: 'mock_tts',
        apiKeyId: null,
        provider: {
          synthesize: async () => ({ audioPath: out1, durationSec: 1.5, provider: 'mock_tts' }),
        },
      },
    ]

    const out = await withProviderFailover(
      { capability: 'TTS', candidates, maxAttempts: 2 },
      async (cand) => {
        return cand.provider.synthesize({ text: 'Thử nghiệm sau khi tắt service', outPath: out1 })
      }
    )

    assert(out.provider.id === 'mock_tts', 'Failover redirected from offline ZeroTTS to fallback mock_tts')
    assert(out.result.provider === 'mock_tts', 'Fallback synthesized successfully')
    failoverSucceeded = true
  })
  assert(failoverSucceeded, 'Failover completed successfully when ZeroTTS service was stopped')

} finally {
  // Ensure Python process is killed
  try { pyProcess.kill('SIGKILL') } catch (_) {}
  // Cleanup temp files
  try {
    const files = fs.readdirSync(tmpDir)
    for (const f of files) {
      try { fs.unlinkSync(path.join(tmpDir, f)) } catch (_) {}
    }
    fs.rmdirSync(tmpDir)
  } catch (_) {}
}

if (failures > 0) {
  console.error(`\n${failures} INTEGRATION TESTS FAILED`)
  process.exit(1)
} else {
  console.log('\nALL PASS: ZeroTTS end-to-end integration verified successfully!')
}
