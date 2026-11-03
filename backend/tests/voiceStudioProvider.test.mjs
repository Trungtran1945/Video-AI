import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { VoiceStudio } from '../src/providers/tts/voiceStudio.js'
import { PROVIDER_LABELS, getProvider, listProvidersForCapability } from '../src/providers/registry.js'
import { buildTtsCacheInput, ttsClipKey } from '../src/lib/ttsCacheKey.js'

async function runTests() {
  console.log('[test] 1. VoiceStudio constructor & default config')
  const p = new VoiceStudio()
  assert.equal(p.id, 'voicestudio', 'VoiceStudio id is "voicestudio"')
  assert.equal(p.model, 'tts-1', 'Default model is "tts-1"')
  assert.equal(p.voice, 'default', 'Default voice is "default"')
  assert.equal(p.baseUrl, 'http://127.0.0.1:3900', 'Default baseUrl is "http://127.0.0.1:3900"')

  console.log('[test] 2. Registry labels and keyless resolution')
  assert.equal(PROVIDER_LABELS.voicestudio, 'VoiceStudio (Local)', 'PROVIDER_LABELS contains "VoiceStudio (Local)"')
  const resolved = await getProvider('test-user', 'tts', { id: 'voicestudio' })
  assert.equal(resolved.id, 'voicestudio', 'getProvider returns voicestudio id')

  const candidates = await listProvidersForCapability('test-user', 'tts', { id: 'voicestudio' })
  assert.equal(candidates[0].id, 'voicestudio', 'voicestudio is first candidate when preferred')
  assert.equal(candidates[0].apiKeyId, null, 'voicestudio candidate has null apiKeyId')

  console.log('[test] 3. Cache key identity')
  const inputA = buildTtsCacheInput({ provider: 'voicestudio', voice: 'alloy', model: 'tts-1', text: 'Xin chào', speed: 1 })
  const keyA = ttsClipKey(inputA)
  assert.equal(typeof keyA, 'string', 'ttsClipKey returns string')
  assert.equal(keyA.length, 64, 'SHA-256 is 64 hex chars')

  const inputB = buildTtsCacheInput({ provider: 'voicestudio', voice: 'echo', model: 'tts-1', text: 'Xin chào', speed: 1 })
  const keyB = ttsClipKey(inputB)
  assert.notEqual(keyA, keyB, 'Different voice yields different cache key')

  console.log('[test] 4. Mock HTTP Server tests (health & speech synthesis)')
  let lastRequestBody = null
  let lastHeaders = null
  let requestPath = ''

  // Create a minimal 44-byte silent WAV header buffer for synthesis testing
  const wavHeader = Buffer.alloc(44)
  wavHeader.write('RIFF', 0)
  wavHeader.writeUInt32LE(36 + 1000, 4)
  wavHeader.write('WAVE', 8)
  wavHeader.write('fmt ', 12)
  wavHeader.writeUInt32LE(16, 16)
  wavHeader.writeUInt16LE(1, 20) // PCM
  wavHeader.writeUInt16LE(1, 22) // 1 channel
  wavHeader.writeUInt32LE(24000, 24) // 24000 sample rate
  wavHeader.writeUInt32LE(48000, 28) // byte rate
  wavHeader.writeUInt16LE(2, 32) // block align
  wavHeader.writeUInt16LE(16, 34) // 16 bits
  wavHeader.write('data', 36)
  wavHeader.writeUInt32LE(1000, 40)
  const fakeWav = Buffer.concat([wavHeader, Buffer.alloc(1000)])

  const server = http.createServer((req, res) => {
    requestPath = req.url
    lastHeaders = req.headers
    let chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try { lastRequestBody = JSON.parse(raw) } catch (_) { lastRequestBody = raw }

      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', models: ['tts-1'], voices: ['alloy', 'echo'] }))
      } else if (req.url === '/v1/audio/speech') {
        if (!lastRequestBody?.input) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Input text required' } }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'audio/wav' })
        res.end(fakeWav)
      } else {
        res.writeHead(404)
        res.end()
      }
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const vs = new VoiceStudio()
  vs.baseUrl = `http://127.0.0.1:${port}`

  try {
    // Health check test
    const health = await vs.checkHealth()
    assert.equal(health.ok, true, 'checkHealth ok is true')
    assert.equal(health.status, 'ok', 'checkHealth status is "ok"')

    // Speech synthesize test
    const tmpOut = path.resolve('storage/tmp/test_voicestudio.wav')
    const synthRes = await vs.synthesize({
      text: 'Thử nghiệm VoiceStudio',
      outPath: tmpOut,
      voice: 'alloy',
      speed: 1.0,
      language: 'vi'
    })

    assert.equal(synthRes.provider, 'voicestudio', 'Provider is voicestudio')
    assert.equal(requestPath, '/v1/audio/speech', 'Requested /v1/audio/speech')
    assert.equal(lastRequestBody.input, 'Thử nghiệm VoiceStudio', 'Correct text in payload')
    assert.equal(lastRequestBody.voice, 'alloy', 'Correct voice in payload')
    assert.equal(lastRequestBody.model, 'tts-1', 'Correct model in payload')
    assert.ok(fs.existsSync(tmpOut), 'Output audio file exists')
    try { fs.unlinkSync(tmpOut) } catch (_) {}

    // Empty text validation
    await assert.rejects(
      async () => vs.synthesize({ text: '  ', outPath: tmpOut }),
      /TTS text rỗng/,
      'Rejects empty text with invalid request error'
    )
  } finally {
    await new Promise(resolve => server.close(resolve))
  }

  console.log('ALL TESTS PASSED 100%')
}

runTests().catch(err => {
  console.error('Test failed:', err)
  process.exit(1)
})
