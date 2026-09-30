// ASR single-flight: 100 concurrent same-key → provider called once.
// Failure → all waiters receive failure. Retry possible after cleanup.
// No memory leak. Non-cacheable bypasses single-flight.
// Run: node backend/tests/asrCacheSingleFlight.test.mjs
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_singleflight_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { callProvider, __clearInFlightForTests, __inFlightSizeForTests } = await import('../src/lib/callProvider.js')
const { buildAsrCacheInput } = await import('../src/lib/asrCacheKey.js')

await initSchema()
__clearInFlightForTests()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

function mkInput(tag) {
  return buildAsrCacheInput({
    audioContentHash: tag,
    sourceLanguage: 'vi',
    effectiveModel: 'whisper-1',
    temperature: 0,
    initialPrompt: '',
    responseFormat: 'verbose_json',
    endpoint: 'https://api.openai.com/v1',
  })
}

// 1. 100 concurrent same-key → 1 provider call
{
  __clearInFlightForTests()
  let providerCalls = 0
  const input = mkInput('a'.repeat(64))
  const fn = async () => {
    providerCalls++
    await new Promise((r) => setTimeout(r, 50))
    return { language: 'vi', segments: [{ start: 0, end: 1, text: 'hello' }] }
  }
  const promises = Array.from({ length: 100 }, () =>
    callProvider({ provider: 'whisper', type: 'asr', model: 'whisper-1', input, fn, userId: 'u-sf' })
  )
  const results = await Promise.all(promises)
  assert(providerCalls === 1, `100 concurrent same-key → 1 provider call (got ${providerCalls})`)
  assert(results.every((r) => r.segments[0].text === 'hello'), 'all waiters receive same result')
  assert(__inFlightSizeForTests() === 0, 'in-flight map cleaned up (no leak)')
}

// 2. Failure → all waiters receive failure
{
  __clearInFlightForTests()
  let providerCalls = 0
  const input = mkInput('b'.repeat(64))
  const fn = async () => {
    providerCalls++
    await new Promise((r) => setTimeout(r, 30))
    throw new Error('provider boom')
  }
  const promises = Array.from({ length: 20 }, () =>
    callProvider({ provider: 'whisper', type: 'asr', model: 'whisper-1', input, fn, userId: 'u-sf' }).then(
      () => 'resolved',
      (e) => e.message
    )
  )
  const results = await Promise.all(promises)
  assert(providerCalls === 1, `failure single-flight still 1 call (got ${providerCalls})`)
  assert(results.every((m) => m === 'provider boom'), 'all waiters receive failure')
  assert(__inFlightSizeForTests() === 0, 'in-flight cleaned after failure')
}

// 3. Retry possible after cleanup
{
  __clearInFlightForTests()
  let n = 0
  const input = mkInput('c'.repeat(64))
  const failOnce = async () => {
    n++
    if (n === 1) throw new Error('first fails')
    return { ok: true }
  }
  let firstErr = null
  try {
    await callProvider({ provider: 'whisper', type: 'asr', model: 'whisper-1', input, fn: failOnce, userId: 'u-sf' })
  } catch (e) { firstErr = e }
  assert(firstErr?.message === 'first fails', 'first call fails')
  const second = await callProvider({ provider: 'whisper', type: 'asr', model: 'whisper-1', input, fn: failOnce, userId: 'u-sf' })
  assert(second?.ok === true && n === 2, `retry possible after cleanup (n=${n})`)
}

// 4. Non-cacheable (path-only ASR) bypasses single-flight → each calls provider
{
  __clearInFlightForTests()
  let providerCalls = 0
  const mkPathInput = () => ({ file: '/tmp/dub_up_0.mp3', language: 'vi' })
  const fn = async () => {
    providerCalls++
    await new Promise((r) => setTimeout(r, 20))
    return { language: 'vi', segments: [] }
  }
  await Promise.all(Array.from({ length: 5 }, () =>
    callProvider({ provider: 'whisper', type: 'asr', model: 'whisper-1', input: mkPathInput(), fn, userId: 'u-sf' })
  ))
  assert(providerCalls === 5, `non-cacheable bypasses single-flight (calls=${providerCalls})`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
