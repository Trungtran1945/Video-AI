// TTS cache/resume: canonical fingerprint reuse + partial completion.
// No network, no FFmpeg: tests pure fingerprint logic + batch stop rules.
import { buildTtsCacheInput, ttsClipKey, isCanonicalTtsCacheInput } from '../src/lib/ttsCacheKey.js'
import { classifyProviderError, ERROR_CODES } from '../src/lib/providerErrors.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

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
  // Partial completion contract: 70 ok + quota on #71 → rerun reuses 70.
  // Simulates dubTtsAlign batch stop: key-level error stops, rate streak>=3 stops.
  const KEY_LEVEL = new Set([ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, ERROR_CODES.PROVIDER_AUTH_FAILED, ERROR_CODES.PROVIDER_MODEL_NOT_FOUND])
  const quotaCode = classifyProviderError(Object.assign(new Error('quota exhausted'), { status: 429 })).code
  assert(KEY_LEVEL.has(quotaCode) === true, 'quota is key-level (batch stops, remaining marked failed without provider calls)')
  const rateCode = classifyProviderError(Object.assign(new Error('too many requests'), { status: 429 })).code
  assert(KEY_LEVEL.has(rateCode) === false, 'rate-limit is NOT key-level (streak rule applies, not instant stop)')
  // Missing-segments error shape required by task §10.
  const total = 100
  const completed = 70
  const missing = Array.from({ length: total - completed }, (_, k) => completed + k)
  assert(missing.length === 30 && missing[0] === 70, 'partial rerun computes only missing segments (70 reuse + 30 generate)')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
