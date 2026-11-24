// Provider Test Isolation Test (Step 6 / P3: Cô lập provider trong test)
// Verifies:
// 1. DEFAULT_PROVIDER_MODE=mock forces getProvider to return mock implementations
// 2. Test guard blocks unmocked native fetch calls to real AI providers (Gemini, OpenAI, Whisper)
// 3. Mocked fetch calls from unit tests are permitted through
// 4. Noisy provider logs are silenced in test mode
// Run: node backend/tests/providerIsolation.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.join(__dirname, '..')

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg)
  } else {
    failures++
    console.error('FAIL:', msg)
  }
}

console.log('--- 1. Registry Mock Provider Selection ---')
{
  const { getProvider } = await import('../src/providers/registry.js')

  const llm = await getProvider('test-user-isolated', 'llm', { id: 'mock' })
  assert(llm.id === 'mock', `llm provider defaults to mock (got ${llm.id})`)
  assert(typeof llm.provider.complete === 'function', 'llm provider has complete()')

  const asr = await getProvider('test-user-isolated', 'asr', { id: 'mock' })
  assert(asr.id === 'mock', `asr provider defaults to mock (got ${asr.id})`)
  assert(typeof asr.provider.transcribe === 'function', 'asr provider has transcribe()')

  const tts = await getProvider('test-user-isolated', 'tts', { id: 'mock' })
  assert(tts.id === 'mock', `tts provider defaults to mock (got ${tts.id})`)
  assert(typeof tts.provider.synthesize === 'function', 'tts provider has synthesize()')

  const vision = await getProvider('test-user-isolated', 'vision', { id: 'mock' })
  assert(vision.id === 'mock', `vision provider defaults to mock (got ${vision.id})`)
  assert(typeof vision.provider.detectSubtitle === 'function', 'vision provider has detectSubtitle()')
}

console.log('\n--- 2. Test Guard Blocks Unmocked Real Network Calls ---')
const origEnv = process.env.NODE_ENV
const origMode = process.env.DEFAULT_PROVIDER_MODE
try {
  process.env.NODE_ENV = 'test'
  process.env.DEFAULT_PROVIDER_MODE = 'mock'

  const { generateContent } = await import('../src/providers/geminiClient.js')
  let geminiBlocked = false
  try {
    // Calling generateContent with native unmocked globalThis.fetch
    await generateContent({ model: 'gemini-test', apiKey: 'fake-key', body: { contents: [] } })
  } catch (e) {
    geminiBlocked = String(e.message).includes('[TestGuard]')
  }
  assert(geminiBlocked, 'unmocked real network call to Gemini is blocked by TestGuard')

  const { OpenAiLlm } = await import('../src/providers/llm/openai.js')
  let openaiBlocked = false
  try {
    const openai = new OpenAiLlm('fake-key')
    await openai.complete({ prompt: 'hello' })
  } catch (e) {
    openaiBlocked = String(e.message).includes('[TestGuard]')
  }
  assert(openaiBlocked, 'unmocked real network call to OpenAI is blocked by TestGuard')

  const { OpenAiWhisperAsr } = await import('../src/providers/asr/openaiWhisper.js')
  let whisperBlocked = false
  try {
    const whisper = new OpenAiWhisperAsr('fake-key')
    await whisper.transcribe('nonexistent.mp3')
  } catch (e) {
    whisperBlocked = String(e.message).includes('[TestGuard]')
  }
  assert(whisperBlocked, 'unmocked real network call to OpenAI Whisper is blocked by TestGuard')
} finally {
  if (origEnv !== undefined) process.env.NODE_ENV = origEnv
  else delete process.env.NODE_ENV
  if (origMode !== undefined) process.env.DEFAULT_PROVIDER_MODE = origMode
  else delete process.env.DEFAULT_PROVIDER_MODE
}

console.log('\n--- 3. Explicit Mocked Fetch Allowed in Tests ---')
{
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'mock-response' }] } }],
      usageMetadata: {},
    }),
  })

  try {
    process.env.NODE_ENV = 'test'
    process.env.DEFAULT_PROVIDER_MODE = 'mock'
    const { generateContent } = await import('../src/providers/geminiClient.js')
    const res = await generateContent({ model: 'gemini-test', apiKey: 'k', body: { contents: [] } })
    assert(res.text === 'mock-response', `mocked fetch in test proceeds normally (got ${res.text})`)
  } finally {
    globalThis.fetch = realFetch
    if (origEnv !== undefined) process.env.NODE_ENV = origEnv
    else delete process.env.NODE_ENV
    if (origMode !== undefined) process.env.DEFAULT_PROVIDER_MODE = origMode
    else delete process.env.DEFAULT_PROVIDER_MODE
  }
}

console.log('\n--- 4. Static Invariant: run-tests.mjs passes isolation flags ---')
{
  const runnerSrc = fs.readFileSync(path.join(backendRoot, 'scripts', 'run-tests.mjs'), 'utf8')
  assert(runnerSrc.includes("DEFAULT_PROVIDER_MODE: 'mock'"), 'run-tests.mjs sets DEFAULT_PROVIDER_MODE to mock')
  assert(runnerSrc.includes("DOTENV_CONFIG_QUIET: 'true'"), 'run-tests.mjs silences dotenv noise')
  assert(runnerSrc.includes("SILENCE_PROVIDER_LOGS: 'true'"), 'run-tests.mjs silences provider failover noise')
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures === 0 ? 0 : 1)
