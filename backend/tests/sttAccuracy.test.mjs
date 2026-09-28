// STT accuracy regression: language normalize, chunk overlap, hallucination filter,
// Whisper params (temperature/prompt), ASR cache by content hash.
// Run: node backend/tests/sttAccuracy.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

// ── 1. sttUtils pure helpers ──
const { normalizeSttLanguage, buildSttChunks, isHallucinatedText, filterHallucinatedSegments, resolveSttSourceLanguage } =
  await import('../src/pipeline/sttUtils.js')

assert(normalizeSttLanguage('auto') === undefined, 'auto → undefined (auto-detect)')
assert(normalizeSttLanguage('unknown') === undefined, 'unknown → undefined')
assert(normalizeSttLanguage('') === undefined, 'empty → undefined')
assert(normalizeSttLanguage('vi') === 'vi', 'vi kept')
assert(normalizeSttLanguage('vi-VN') === 'vi', 'vi-VN → vi')
assert(normalizeSttLanguage('ZH-CN') === 'zh', 'ZH-CN → zh')
assert(normalizeSttLanguage('en-US') === 'en', 'en-US → en')

// chunk overlap: 650s with 300s chunk + 15s overlap → step 285
{
  const chunks = buildSttChunks(650, { chunkSec: 300, overlapSec: 15 })
  assert(chunks.length === 3, `650s → 3 chunks (got ${chunks.length})`)
  assert(chunks[0].start === 0, 'chunk0 starts at 0')
  assert(chunks[1].start === 285, `chunk1 starts at 285 (got ${chunks[1].start})`)
  assert(Math.abs(chunks[2].start + chunks[2].dur - 650) < 0.01, 'last chunk ends at duration')
  // short video → single chunk, no overlap
  const single = buildSttChunks(120, { chunkSec: 300, overlapSec: 15 })
  assert(single.length === 1 && single[0].start === 0 && single[0].dur === 120, 'short video → single chunk')
}

// hallucination filter
{
  assert(isHallucinatedText('ah ah ah ah ah ah ah') === true, 'repeated token loop flagged')
  assert(isHallucinatedText('Hello world, how are you today?') === false, 'normal sentence kept')
  assert(isHallucinatedText('   ') === true, 'blank flagged')
  assert(isHallucinatedText('谢谢谢谢谢谢谢谢谢谢谢谢谢谢') === true, 'CJK single-char loop flagged')
  const filtered = filterHallucinatedSegments([
    { start: 0, end: 2, text: 'Hello world' },
    { start: 2, end: 4, text: 'ah ah ah ah ah ah ah' },
    { start: 4, end: 6, text: '   ' },
    { start: 6, end: 8, text: 'We need to move quickly.' },
  ])
  assert(filtered.length === 2, `hallucinations removed, kept 2 (got ${filtered.length})`)
  // high no_speech_prob dropped even with text
  const filtered2 = filterHallucinatedSegments([
    { start: 0, end: 2, text: 'music playing', noSpeechProb: 0.9 },
    { start: 2, end: 4, text: 'real speech here', noSpeechProb: 0.1 },
  ])
  assert(filtered2.length === 1 && filtered2[0].text === 'real speech here', 'high no_speech_prob dropped')
}

// resolve source language: prefers params.sourceLanguage, never project.language (target)
{
  assert(resolveSttSourceLanguage({ params: JSON.stringify({ sourceLanguage: 'zh', targetLanguage: 'vi' }), language: 'vi' }) === 'zh', 'params zh preferred over project vi')
  assert(resolveSttSourceLanguage({ params: JSON.stringify({ sourceLanguage: 'auto' }), language: 'vi' }) === undefined, 'auto → undefined, not project.language')
  assert(resolveSttSourceLanguage({ params: '{}', language: 'vi' }) === undefined, 'missing → undefined, not vi target')
}

// ── 2. Whisper provider sends temperature/prompt/normalized language ──
{
  const origFetch = globalThis.fetch
  let capturedForm = null
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ language: 'zh', segments: [{ start: 0, end: 1, text: 'hi' }] }),
  })
  // capture FormData by wrapping global FormData
  const OrigFormData = globalThis.FormData
  const entries = {}
  class CaptureForm extends OrigFormData {
    append(k, v, ...rest) { entries[k] = v; return super.append(k, v, ...rest) }
  }
  globalThis.FormData = CaptureForm
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stt_whisper_'))
    const wav = path.join(tmp, 'a.wav')
    fs.writeFileSync(wav, Buffer.from([0, 1, 2, 3]))
    const { OpenAiWhisperAsr } = await import('../src/providers/asr/openaiWhisper.js')
    const asr = new OpenAiWhisperAsr('test-key')
    const res = await asr.transcribe(wav, { language: 'ZH-CN', prompt: 'phim cổ trang' })
    assert(entries['temperature'] !== undefined, 'temperature sent')
    assert(entries['prompt'] === 'phim cổ trang', 'prompt sent')
    assert(entries['language'] === 'zh', `language normalized zh (got ${entries['language']})`)
    assert(res.segments.length === 1, 'segments returned')
    // auto → no language field
    for (const k of Object.keys(entries)) delete entries[k]
    await asr.transcribe(wav, { language: 'auto' })
    assert(entries['language'] === undefined, 'auto → language omitted (auto-detect)')
    fs.rmSync(tmp, { recursive: true, force: true })
  } finally {
    globalThis.fetch = origFetch
    globalThis.FormData = OrigFormData
  }
}

// ── 3. ASR cache must not reuse by path alone ──
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai_stt_cache_'))
  process.env.DB_PATH = path.join(tmpDir, 'test.db')
  process.env.STORAGE_DIR = path.join(tmpDir, 'storage')
  const { initSchema } = await import('../src/db/schema.js')
  await initSchema()
  const { callProvider } = await import('../src/lib/callProvider.js')
  let calls = 0
  const mkfile = (name, content) => {
    const p = path.join(tmpDir, name)
    fs.writeFileSync(p, content)
    return p
  }
  const f1 = mkfile('dub_up_0.mp3', 'audio-content-A')
  // two calls with same path but different content, no fileHash → must NOT hit cache
  const r1 = await callProvider({
    provider: 'whisper', type: 'asr', model: 'whisper-large-v3-turbo',
    input: { file: f1, language: 'zh' },
    fn: async () => { calls++; return { language: 'zh', segments: [{ start: 0, end: 1, text: 'v1' }] } },
    userId: 'u-cache-test',
  })
  fs.writeFileSync(f1, 'audio-content-B-DIFFERENT')
  const r2 = await callProvider({
    provider: 'whisper', type: 'asr', model: 'whisper-large-v3-turbo',
    input: { file: f1, language: 'zh' },
    fn: async () => { calls++; return { language: 'zh', segments: [{ start: 0, end: 1, text: 'v2' }] } },
    userId: 'u-cache-test',
  })
  assert(calls === 2, `path-only ASR inputs bypass cache (calls=${calls})`)
  assert(r2.segments[0].text === 'v2', 'second content returned, not stale cache')
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
  try { fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}
}

if (failures > 0) { console.error(`\n${failures} FAILURES`); process.exit(1) }
console.log('\nALL PASS')
process.exit(0)
