// Whisper options → cache: prompt/temperature/model/endpoint differences
// produce different canonical inputs (hence cache miss). Same options → equal.
// Run: node backend/tests/whisperOptionsCache.test.mjs
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_wopt_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { callProvider, __clearInFlightForTests } = await import('../src/lib/callProvider.js')
const { buildAsrCacheInput } = await import('../src/lib/asrCacheKey.js')

await initSchema()
__clearInFlightForTests()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const hash = 'a'.repeat(64)
function optInput(overrides = {}) {
  return buildAsrCacheInput({
    audioContentHash: hash,
    sourceLanguage: 'en',
    effectiveModel: 'whisper-1',
    temperature: 0,
    initialPrompt: '',
    responseFormat: 'verbose_json',
    endpoint: 'https://api.openai.com/v1',
    ...overrides,
  })
}

// Canonical equality
{
  assert(JSON.stringify(optInput()) === JSON.stringify(optInput()), 'same options → equal canonical input')
  assert(JSON.stringify(optInput()) !== JSON.stringify(optInput({ initialPrompt: 'x' })), 'different prompt → different input')
  assert(JSON.stringify(optInput()) !== JSON.stringify(optInput({ temperature: 0.5 })), 'different temperature → different input')
  assert(JSON.stringify(optInput()) !== JSON.stringify(optInput({ effectiveModel: 'other' })), 'different model → different input')
  assert(JSON.stringify(optInput()) !== JSON.stringify(optInput({ endpoint: 'https://other/v1' })), 'different endpoint → different input')
}

// Provider-level: same audio, different prompt → 2 calls
{
  __clearInFlightForTests()
  let calls = 0
  const fn = async () => { calls++; return { language: 'en', segments: [] } }
  const base = optInput({ audioContentHash: 'b'.repeat(64) })
  const diff = optInput({ audioContentHash: 'b'.repeat(64), initialPrompt: 'hello' })
  await callProvider({ provider: 'whisper', type: 'asr', model: 'whisper-1', input: base, fn, userId: 'u-wopt' })
  await callProvider({ provider: 'whisper', type: 'asr', model: 'whisper-1', input: diff, fn, userId: 'u-wopt' })
  assert(calls === 2, `prompt change busts cache (calls=${calls})`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
