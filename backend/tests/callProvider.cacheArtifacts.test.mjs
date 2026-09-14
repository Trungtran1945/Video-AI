// Regression test cho lỗi dub.ttsAlign stale TTS cache:
// dubTtsAlign xóa audio_segments rồi callProvider trả về cache HIT
// chứa audioPath đã bị xóa → FFmpeg "No such file or directory".
// Chạy: node tests/callProvider.cacheArtifacts.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_callprov_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { callProvider } = await import('../src/lib/callProvider.js')
const { queryOne } = await import('../src/db/query.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg)
  } else {
    failures++
    console.error('FAIL:', msg)
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-tts-'))
const outPath = path.join(tmpDir, 'seg_00011.mp3')
let fnCalls = 0

// Fake TTS provider: ghi file thật + trả về shape như edgeTts/googleTts
const fakeTtsFn = async () => {
  fnCalls++
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, Buffer.from(`fake-mp3-bytes-${fnCalls}`))
  return { audioPath: outPath, durationSec: 1.5, provider: 'test_tts', model: 'test' }
}

const baseParams = {
  provider: 'test_tts',
  type: 'tts',
  model: 'test',
  input: { text: 'xin chào', outPath, speed: 1 },
  userId: 'user-1',
  projectId: null,
  jobId: null,
}

// TEST 1 — Fresh TTS: không cache → provider chạy, file tạo, cache lưu
const r1 = await callProvider({ ...baseParams, fn: fakeTtsFn })
assert(fnCalls === 1, `fresh TTS gọi provider 1 lần (thực tế ${fnCalls})`)
assert(fs.existsSync(outPath), 'fresh TTS tạo file MP3')
assert(r1.audioPath === outPath, 'fresh TTS trả về audioPath đúng')

// TEST 2 — Valid cache: file còn tồn tại → HIT, provider KHÔNG chạy lại
const r2 = await callProvider({ ...baseParams, fn: fakeTtsFn })
assert(fnCalls === 1, `valid cache không gọi lại provider (thực tế ${fnCalls})`)
assert(r2.audioPath === outPath, 'valid cache trả về audioPath đã lưu')

// TEST 3 — Stale cache: xóa file (mô phỏng dubTtsAlign rm audio_segments)
// → phải coi là MISS, chạy lại provider, tái tạo file, cập nhật cache
fs.rmSync(outPath, { force: true })
assert(!fs.existsSync(outPath), 'điều kiện tái hiện: file MP3 đã bị xóa')
const r3 = await callProvider({ ...baseParams, fn: fakeTtsFn })
assert(fnCalls === 2, `stale cache phải chạy lại provider (thực tế ${fnCalls})`)
assert(fs.existsSync(outPath), 'stale cache tái tạo file MP3')
assert(r3.audioPath === outPath, 'stale cache trả về audioPath mới')

// TEST 4 — Kết quả không chứa artifact (LLM text) → giữ nguyên cache HIT
let llmCalls = 0
const llmParams = {
  provider: 'test_llm',
  type: 'llm',
  model: 'test',
  input: { prompt: 'hello', temperature: 0.3 },
  userId: 'user-1',
  projectId: null,
  jobId: null,
}
await callProvider({ ...llmParams, fn: async () => { llmCalls++; return { text: 'xin chào' } } })
await callProvider({ ...llmParams, fn: async () => { llmCalls++; return { text: 'xin chào' } } })
assert(llmCalls === 1, `cache text không artifact vẫn HIT (thực tế ${llmCalls})`)

// TEST 5 — Remote URL không phải local artifact → không kiểm tra fs
let urlCalls = 0
const urlOut = 'https://example.com/audio/seg.mp3'
const urlParams = {
  provider: 'test_tts',
  type: 'tts',
  model: 'test',
  input: { text: 'remote', outPath: urlOut, speed: 1 },
  userId: 'user-1',
  projectId: null,
  jobId: null,
}
await callProvider({ ...urlParams, fn: async () => { urlCalls++; return { audioPath: urlOut, durationSec: 1 } } })
await callProvider({ ...urlParams, fn: async () => { urlCalls++; return { audioPath: urlOut, durationSec: 1 } } })
assert(urlCalls === 1, `remote URL vẫn HIT, không check fs (thực tế ${urlCalls})`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
