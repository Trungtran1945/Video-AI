// Whisper effective config: model/temperature/prompt/endpoint affect cache
// and request. Mid-process env changes honored. No secrets in identity.
// Run: node backend/tests/whisperEffectiveModel.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const mod = await import('../src/providers/asr/openaiWhisper.js')
const { getWhisperEffectiveConfig, getWhisperEffectiveModel, getWhisperEndpoint, WHISPER_RESPONSE_FORMAT } = mod

// 1. Defaults
{
  delete process.env.WHISPER_MODEL
  delete process.env.WHISPER_BASE_URL
  delete process.env.WHISPER_TEMPERATURE
  delete process.env.WHISPER_INITIAL_PROMPT
  const cfg = getWhisperEffectiveConfig()
  assert(cfg.model === 'whisper-1', `default model whisper-1 (got ${cfg.model})`)
  assert(cfg.temperature === 0, `default temperature 0 (got ${cfg.temperature})`)
  assert(cfg.initialPrompt === '', 'default prompt empty')
  assert(cfg.responseFormat === 'verbose_json' || cfg.responseFormat === WHISPER_RESPONSE_FORMAT, 'response_format verbose_json')
  assert(cfg.endpoint === 'https://api.openai.com/v1', `default endpoint (got ${cfg.endpoint})`)
}

// 2. Env overrides honored
{
  process.env.WHISPER_MODEL = 'whisper-large-v3-turbo'
  process.env.WHISPER_TEMPERATURE = '0.7'
  process.env.WHISPER_INITIAL_PROMPT = 'phim cổ trang'
  process.env.WHISPER_BASE_URL = 'https://api.groq.com/openai/v1/'
  const cfg = getWhisperEffectiveConfig()
  assert(cfg.model === 'whisper-large-v3-turbo', 'env model honored')
  assert(cfg.temperature === 0.7, `env temperature honored (got ${cfg.temperature})`)
  assert(cfg.initialPrompt === 'phim cổ trang', 'env prompt honored')
  assert(cfg.endpoint === 'https://api.groq.com/openai/v1', `endpoint trailing slash normalized (got ${cfg.endpoint})`)
  assert(getWhisperEffectiveModel() === 'whisper-large-v3-turbo', 'getWhisperEffectiveModel honors env')
  assert(getWhisperEndpoint() === 'https://api.groq.com/openai/v1', 'getWhisperEndpoint normalized')
}

// 3. Per-call overrides win over env
{
  const cfg = getWhisperEffectiveConfig({ temperature: 0.2, prompt: 'override prompt' })
  assert(cfg.temperature === 0.2, 'per-call temperature wins')
  assert(cfg.initialPrompt === 'override prompt', 'per-call prompt wins')
}

// 4. Prompt sliced to provider limit, no secrets
{
  const long = 'x'.repeat(500)
  const cfg = getWhisperEffectiveConfig({ prompt: long })
  assert(cfg.initialPrompt.length <= 224, `prompt sliced to ≤224 (got ${cfg.initialPrompt.length})`)
  const serialized = JSON.stringify(cfg).toLowerCase()
  assert(!serialized.includes('apikey') && !serialized.includes('authorization') && !serialized.includes('bearer'), 'no secrets in effective config')
}

// 5. Transcribe sends effective model/temperature/prompt (capture FormData)
{
  const origFetch = globalThis.fetch
  const OrigFormData = globalThis.FormData
  const entries = {}
  class CaptureForm extends OrigFormData {
    append(k, v, ...rest) { entries[k] = v; return super.append(k, v, ...rest) }
  }
  globalThis.FormData = CaptureForm
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ language: 'vi', segments: [] }) })
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper_eff_'))
    const wav = path.join(tmp, 'a.wav')
    fs.writeFileSync(wav, Buffer.from([0, 1, 2, 3]))
    process.env.WHISPER_MODEL = 'whisper-large-v3-turbo'
    const { OpenAiWhisperAsr } = await import('../src/providers/asr/openaiWhisper.js')
    const asr = new OpenAiWhisperAsr('test-key')
    await asr.transcribe(wav, { language: 'vi' })
    assert(entries['model'] === 'whisper-large-v3-turbo', `transcribe sends effective model (got ${entries['model']})`)
    assert(entries['temperature'] !== undefined, 'transcribe sends temperature')
    assert(entries['response_format'] === 'verbose_json', 'transcribe sends response_format')
    fs.rmSync(tmp, { recursive: true, force: true })
  } finally {
    globalThis.fetch = origFetch
    globalThis.FormData = OrigFormData
  }
  delete process.env.WHISPER_MODEL
  delete process.env.WHISPER_TEMPERATURE
  delete process.env.WHISPER_INITIAL_PROMPT
  delete process.env.WHISPER_BASE_URL
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
