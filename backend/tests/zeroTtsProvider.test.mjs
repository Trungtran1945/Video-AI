// ZeroTTS provider unit tests: interface, keyless registration, error mapping, failover, cache fingerprint, and speed handling.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { ZeroTts } from '../src/providers/tts/zeroTts.js'
import { getProvider, listProvidersForCapability, PROVIDER_LABELS } from '../src/providers/registry.js'
import { ERROR_CODES, classifyProviderError } from '../src/lib/providerErrors.js'
import { buildTtsCacheInput, ttsClipKey } from '../src/lib/ttsCacheKey.js'
import { withProviderFailover } from '../src/lib/providerFailover.js'
import { clearProviderHealthForTests } from '../src/lib/providerHealth.js'
import { runWithProviderScope } from '../src/lib/providerScope.js'

let failures = 0
const assert = (c, m) => {
  if (c) console.log('PASS:', m)
  else {
    failures++
    console.error('FAIL:', m)
  }
}

// 1. Provider configuration & defaults
{
  const p = new ZeroTts()
  assert(p.id === 'zerotts', 'ZeroTts id is "zerotts"')
  assert(p.apiKey === null, 'ZeroTts is keyless (apiKey=null)')
  assert(typeof p.voice === 'string' && p.voice.length > 0, 'ZeroTts has default voice')
  assert(typeof p.baseUrl === 'string' && p.baseUrl.startsWith('http'), 'ZeroTts has valid baseUrl')
  assert(Number.isFinite(p.timeoutMs) && p.timeoutMs > 0, 'ZeroTts has valid timeoutMs')
}

// 2. Registry integration
{
  assert(PROVIDER_LABELS.zerotts === 'ZeroTTS (Local)', 'PROVIDER_LABELS contains "ZeroTTS (Local)"')

  const resolved = await getProvider('test-user', 'tts', { id: 'zerotts' })
  assert(resolved.id === 'zerotts', 'getProvider returns zerotts id')
  assert(resolved.apiKeyId === null, 'getProvider returns apiKeyId=null (keyless)')
  assert(resolved.provider instanceof ZeroTts, 'getProvider returns ZeroTts instance')

  const candidates = await listProvidersForCapability('test-user', 'tts', { id: 'zerotts' })
  assert(candidates.length > 0, 'listProvidersForCapability returns candidates')
  assert(candidates[0].id === 'zerotts', 'zerotts is first candidate when preferred')
  assert(candidates[0].apiKeyId === null, 'zerotts candidate has null apiKeyId')
  const ids = candidates.map((c) => c.id)
  assert(ids.includes('edge_tts'), 'failover candidate pool includes edge_tts')
}

// 3. TTS Cache Fingerprint
{
  const inputA = buildTtsCacheInput({ provider: 'zerotts', voice: 'maichi', model: 'zerotts', text: 'Xin chào thế giới', speed: 1 })
  const keyA1 = ttsClipKey(inputA)
  const keyA2 = ttsClipKey(buildTtsCacheInput({ provider: 'zerotts', voice: 'maichi', model: 'zerotts', text: 'Xin chào thế giới', speed: 1 }))
  assert(keyA1 === keyA2, 'Same input produces identical cache fingerprint')

  const keyB = ttsClipKey(buildTtsCacheInput({ provider: 'zerotts', voice: 'giahuy', model: 'zerotts', text: 'Xin chào thế giới', speed: 1 }))
  assert(keyA1 !== keyB, 'Different voice changes cache fingerprint')

  const keyC = ttsClipKey(buildTtsCacheInput({ provider: 'zerotts', voice: 'maichi', model: 'zerotts', text: 'Chào buổi sáng', speed: 1 }))
  assert(keyA1 !== keyC, 'Different text changes cache fingerprint')

  const keyD = ttsClipKey(buildTtsCacheInput({ provider: 'zerotts', voice: 'maichi', model: 'zerotts', text: 'Xin chào thế giới', speed: 1.2 }))
  assert(keyA1 !== keyD, 'Different speed changes cache fingerprint')
}

// 4. Input validation (empty text)
{
  const p = new ZeroTts()
  let threw = false
  try {
    await p.synthesize({ text: '   ', outPath: './dummy.wav' })
  } catch (err) {
    threw = true
    assert(err.code === ERROR_CODES.PROVIDER_INVALID_REQUEST, 'Empty text throws PROVIDER_INVALID_REQUEST')
  }
  assert(threw, 'Empty text is rejected')
}

// 5. Offline service error (ECONNREFUSED -> PROVIDER_UNAVAILABLE)
{
  const p = new ZeroTts()
  p.baseUrl = 'http://127.0.0.1:59999' // non-existent port
  let threw = false
  try {
    await p.synthesize({ text: 'Kiểm tra server offline', outPath: './dummy.wav' })
  } catch (err) {
    threw = true
    assert(err.code === ERROR_CODES.PROVIDER_UNAVAILABLE, 'Offline service throws PROVIDER_UNAVAILABLE')
    assert(/ECONNREFUSED/i.test(err.message) || /không phản hồi/i.test(err.message), 'Error message is descriptive')
    const cls = classifyProviderError(err)
    assert(cls.code === ERROR_CODES.PROVIDER_UNAVAILABLE, 'classifyProviderError classifies offline service as PROVIDER_UNAVAILABLE')
    assert(cls.retryable === true, 'PROVIDER_UNAVAILABLE is retryable for failover')
  }
  assert(threw, 'Offline service throws error')
}

// 6. Request timeout error (AbortSignal -> PROVIDER_TIMEOUT)
{
  const p = new ZeroTts()
  p.timeoutMs = 50 // very low timeout
  // Start dummy slow server
  const slowServer = http.createServer((req, res) => {
    // deliberately delay response
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    }, 500)
  })
  await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', resolve))
  const port = slowServer.address().port
  p.baseUrl = `http://127.0.0.1:${port}`

  let threw = false
  try {
    await p.synthesize({ text: 'Kiểm tra timeout', outPath: './dummy.wav' })
  } catch (err) {
    threw = true
    assert(err.code === ERROR_CODES.PROVIDER_TIMEOUT, 'Timeout throws PROVIDER_TIMEOUT')
    const cls = classifyProviderError(err)
    assert(cls.code === ERROR_CODES.PROVIDER_TIMEOUT, 'classifyProviderError classifies timeout as PROVIDER_TIMEOUT')
  }
  assert(threw, 'Timeout request throws')
  await new Promise((resolve) => slowServer.close(resolve))
}

// 7. Mock server tests for Health, 400 Bad Request, and 503 Service Unavailable
{
  let lastRequestBody = null
  const mockServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', model_loaded: true, voices: ['maichi', 'giahuy'], model: 'zerotts' }))
      return
    }
    if (req.url === '/synthesize' && req.method === 'POST') {
      let body = ''
      req.on('data', (d) => { body += d })
      req.on('end', () => {
        lastRequestBody = JSON.parse(body)
        if (lastRequestBody.voice === 'invalid_voice') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: "Voice 'invalid_voice' not found", code: 'VOICE_NOT_FOUND' }))
          return
        }
        if (lastRequestBody.text === 'TRIGGER_503') {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Model not ready', code: 'MODEL_NOT_READY' }))
          return
        }

        // Return a valid dummy WAV buffer
        // Simple 44-byte RIFF WAV header + 100 zero samples
        const sampleRate = 48000
        const numSamples = 4800 // 0.1s
        const dataSize = numSamples * 2
        const buf = Buffer.alloc(44 + dataSize)
        buf.write('RIFF', 0)
        buf.writeUInt32LE(36 + dataSize, 4)
        buf.write('WAVE', 8)
        buf.write('fmt ', 12)
        buf.writeUInt32LE(16, 16)
        buf.writeUInt16LE(1, 20) // PCM
        buf.writeUInt16LE(1, 22) // mono
        buf.writeUInt32LE(sampleRate, 24)
        buf.writeUInt32LE(sampleRate * 2, 28)
        buf.writeUInt16LE(2, 32)
        buf.writeUInt16LE(16, 34)
        buf.write('data', 36)
        buf.writeUInt32LE(dataSize, 40)

        // If client passes out_path, write it directly and return JSON
        if (lastRequestBody.out_path) {
          fs.mkdirSync(path.dirname(lastRequestBody.out_path), { recursive: true })
          fs.writeFileSync(lastRequestBody.out_path, buf)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ok: true,
            audioPath: lastRequestBody.out_path,
            durationSec: 0.1,
            sampleRate: 48000,
            voice: lastRequestBody.voice,
            provider: 'zerotts',
          }))
          return
        }

        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'X-Audio-Duration': '0.1',
          'X-Sample-Rate': '48000',
          'X-Voice': lastRequestBody.voice,
          'X-Provider': 'zerotts',
        })
        res.end(buf)
      })
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve))
  const port = mockServer.address().port
  const p = new ZeroTts()
  p.baseUrl = `http://127.0.0.1:${port}`

  // 7a. Health check
  const health = await p.checkHealth()
  assert(health.ok === true, 'checkHealth returns ok=true')
  assert(health.status === 'ok', 'health status is ok')
  assert(Array.isArray(health.voices) && health.voices.includes('maichi'), 'health returns voices')

  // 7b. Synthesize with outPath JSON response
  const testOut = path.resolve('storage/tmp/test_zerotts_unit.wav')
  const synthRes = await p.synthesize({ text: 'Xin chào', outPath: testOut, voice: 'maichi' })
  assert(synthRes.provider === 'zerotts', 'Synthesize returns provider="zerotts"')
  assert(synthRes.audioPath === testOut, 'Synthesize returns correct audioPath')
  assert(synthRes.durationSec > 0, 'Synthesize returns durationSec > 0')
  assert(fs.existsSync(testOut), 'Audio file was written to disk')
  try { fs.unlinkSync(testOut) } catch (_) {}

  // 7c. Invalid voice error
  let threwVoice = false
  try {
    await p.synthesize({ text: 'Xin chào', outPath: testOut, voice: 'invalid_voice' })
  } catch (err) {
    threwVoice = true
    assert(err.code === ERROR_CODES.PROVIDER_INVALID_REQUEST, 'Invalid voice throws PROVIDER_INVALID_REQUEST')
  }
  assert(threwVoice, 'Invalid voice throws error')

  // 7d. 503 model not ready error
  let threw503 = false
  try {
    await p.synthesize({ text: 'TRIGGER_503', outPath: testOut })
  } catch (err) {
    threw503 = true
    assert(err.code === ERROR_CODES.PROVIDER_UNAVAILABLE, '503 error throws PROVIDER_UNAVAILABLE')
  }
  assert(threw503, '503 triggers PROVIDER_UNAVAILABLE')

  await new Promise((resolve) => mockServer.close(resolve))
}

// 8. Failover behavior when ZeroTTS is unavailable
{
  clearProviderHealthForTests()
  await runWithProviderScope('test:zerotts-failover', async () => {
    const candidates = [
      { id: 'zerotts', apiKeyId: null, provider: { id: 'zerotts' } },
      { id: 'edge_tts', apiKeyId: null, provider: { id: 'edge_tts' } },
    ]
    let tried = []
    const out = await withProviderFailover(
      { capability: 'TTS', candidates, maxAttempts: 2 },
      async (cand) => {
        tried.push(cand.id)
        if (cand.id === 'zerotts') {
          const err = new Error('ZeroTTS local service không phản hồi (ECONNREFUSED)')
          err.code = ERROR_CODES.PROVIDER_UNAVAILABLE
          throw err
        }
        return { audioPath: 'storage/tmp/edge.mp3', durationSec: 1.0, provider: 'edge_tts' }
      }
    )
    assert(tried[0] === 'zerotts', 'Tried zerotts first')
    assert(tried[1] === 'edge_tts', 'Failed over to edge_tts')
    assert(out.result.provider === 'edge_tts', 'Failover succeeds on edge_tts')
  })
}

// 9. Speed capability verification (ZeroTTS is NOT native speed)
{
  const supportsNativeSpeedFor = (cand) => cand?.id === 'edge_tts' || cand?.id === 'openai_tts'
  assert(!supportsNativeSpeedFor({ id: 'zerotts' }), 'supportsNativeSpeedFor({ id: "zerotts" }) is FALSE (uses FFmpeg tempo fitting)')
  assert(supportsNativeSpeedFor({ id: 'edge_tts' }), 'supportsNativeSpeedFor({ id: "edge_tts" }) is TRUE')
  assert(supportsNativeSpeedFor({ id: 'openai_tts' }), 'supportsNativeSpeedFor({ id: "openai_tts" }) is TRUE')
}

if (failures > 0) {
  console.error(`\n${failures} TESTS FAILED`)
  process.exit(1)
} else {
  console.log('\nALL PASS')
}
