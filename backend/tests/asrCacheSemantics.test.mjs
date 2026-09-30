// ASR cache semantics: same audio+config → hit; any semantic diff → miss.
// No secrets in cache identity. Legacy rows (missing v2 metadata) → miss.
// Run: node backend/tests/asrCacheSemantics.test.mjs
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_asr_sem_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { callProvider, __clearInFlightForTests } = await import('../src/lib/callProvider.js')
const { buildAsrCacheInput } = await import('../src/lib/asrCacheKey.js')
const { getWhisperEffectiveConfig } = await import('../src/providers/asr/openaiWhisper.js')

await initSchema()
__clearInFlightForTests()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const audioA = 'a'.repeat(64)
const audioB = 'b'.repeat(64)
const eff = getWhisperEffectiveConfig()

function canonical(overrides = {}) {
  return buildAsrCacheInput({
    audioContentHash: audioA,
    sourceLanguage: 'vi',
    effectiveModel: eff.model,
    temperature: eff.temperature,
    initialPrompt: eff.initialPrompt,
    responseFormat: eff.responseFormat,
    endpoint: eff.endpoint,
    ...overrides,
  })
}

let calls = 0
const fn = async (tag) => { calls++; return { language: 'vi', segments: [{ start: 0, end: 1, text: tag }] } }

// 1. Same audio + same config → hit
{
  calls = 0
  const input = canonical()
  await callProvider({ provider: 'whisper', type: 'asr', model: eff.model, input, fn: () => fn('v1'), userId: 'u-sem' })
  await callProvider({ provider: 'whisper', type: 'asr', model: eff.model, input: canonical(), fn: () => fn('v2'), userId: 'u-sem' })
  assert(calls === 1, `same audio+config hits cache (calls=${calls})`)
}

// 2. Different prompt → miss
{
  calls = 0
  const base = canonical({ audioContentHash: 'c'.repeat(64) })
  const diff = canonical({ audioContentHash: 'c'.repeat(64), initialPrompt: 'different prompt xyz' })
  await callProvider({ provider: 'whisper', type: 'asr', model: eff.model, input: base, fn: () => fn('p1'), userId: 'u-sem' })
  await callProvider({ provider: 'whisper', type: 'asr', model: eff.model, input: diff, fn: () => fn('p2'), userId: 'u-sem' })
  assert(calls === 2, `different prompt misses (calls=${calls})`)
}

// 3. Different temperature → miss
{
  calls = 0
  const base = canonical({ audioContentHash: 'd'.repeat(64), temperature: 0 })
  const diff = canonical({ audioContentHash: 'd'.repeat(64), temperature: 0.7 })
  await callProvider({ provider: 'whisper', type: 'asr', model: eff.model, input: base, fn: () => fn('t1'), userId: 'u-sem' })
  await callProvider({ provider: 'whisper', type: 'asr', model: eff.model, input: diff, fn: () => fn('t2'), userId: 'u-sem' })
  assert(calls === 2, `different temperature misses (calls=${calls})`)
}

// 4. Different model → miss
{
  calls = 0
  const base = canonical({ audioContentHash: 'e'.repeat(64), effectiveModel: 'whisper-1' })
  const diff = canonical({ audioContentHash: 'e'.repeat(64), effectiveModel: 'whisper-large-v3-turbo' })
  await callProvider({ provider: 'whisper', type: 'asr', model: 'whisper-1', input: base, fn: () => fn('m1'), userId: 'u-sem' })
  await callProvider({ provider: 'whisper', type: 'asr', model: 'whisper-large-v3-turbo', input: diff, fn: () => fn('m2'), userId: 'u-sem' })
  assert(calls === 2, `different model misses (calls=${calls})`)
}

// 5. Different endpoint semantics → miss
{
  calls = 0
  const base = canonical({ audioContentHash: 'f'.repeat(64), endpoint: 'https://api.openai.com/v1' })
  const diff = canonical({ audioContentHash: 'f'.repeat(64), endpoint: 'https://api.groq.com/openai/v1' })
  await callProvider({ provider: 'whisper', type: 'asr', model: eff.model, input: base, fn: () => fn('e1'), userId: 'u-sem' })
  await callProvider({ provider: 'whisper', type: 'asr', model: eff.model, input: diff, fn: () => fn('e2'), userId: 'u-sem' })
  assert(calls === 2, `different endpoint misses (calls=${calls})`)
}

// 6. Different audio → miss (fresh hashes, isolated from earlier tests)
{
  calls = 0
  const hashA = '1'.repeat(64)
  const hashB = '2'.repeat(64)
  const a = canonical({ audioContentHash: hashA })
  const b = canonical({ audioContentHash: hashB })
  await callProvider({ provider: 'whisper', type: 'asr', model: eff.model, input: a, fn: () => fn('a1'), userId: 'u-sem' })
  await callProvider({ provider: 'whisper', type: 'asr', model: eff.model, input: b, fn: () => fn('b1'), userId: 'u-sem' })
  assert(calls === 2, `different audio misses (calls=${calls})`)
}

// 7. No secret in cache identity
{
  const input = canonical()
  const serialized = JSON.stringify(input)
  const lower = serialized.toLowerCase()
  assert(!lower.includes('apikey') && !lower.includes('authorization') && !lower.includes('secret') && !lower.includes('password') && !lower.includes('bearer'), 'no secret in cache identity')
  assert(!('file' in input) && !('audioPath' in input) && !('path' in input), 'no temporary path in cache identity')
}

// 8. Legacy rows (old {fileHash, language} shape) → miss vs canonical
{
  calls = 0
  const freshHash = '3'.repeat(64)
  const legacyInput = { fileHash: freshHash, language: 'vi' }
  await callProvider({ provider: 'whisper', type: 'asr', model: eff.model, input: legacyInput, fn: async () => { calls++; return { language: 'vi', segments: [] } }, userId: 'u-sem' })
  const canon = canonical({ audioContentHash: freshHash })
  await callProvider({ provider: 'whisper', type: 'asr', model: eff.model, input: canon, fn: async () => { calls++; return { language: 'vi', segments: [] } }, userId: 'u-sem' })
  assert(calls === 2, `legacy shape does not hit canonical (calls=${calls})`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
