// BE-C06 regression: cross-project TTS artifact isolation (PLAN §2.1/§4.2 QA-CACHE/QA-SF/QA-CH).
// - concurrent A+B cùng canonical input → không bên nào nhận path bên kia, mỗi bên file riêng.
// - legacy cache có local path không ownership → MISS (không trả path lạ), provider chạy lại.
// - DB-hit → cacheHit:true; execution → cacheHit:false (BE-C05).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_iso_${Date.now()}_${process.pid}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { callProvider, __clearInFlightForTests } = await import('../src/lib/callProvider.js')
const { config } = await import('../src/config.js')
const { buildTtsCacheInput } = await import('../src/lib/ttsCacheKey.js')

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const projA = 'iso-proj-A'
const projB = 'iso-proj-B'
const dirA = path.join(config.storageDir, 'projects', projA)
const dirB = path.join(config.storageDir, 'projects', projB)
fs.mkdirSync(dirA, { recursive: true })
fs.mkdirSync(dirB, { recursive: true })
const fileA = path.join(dirA, 'clip_iso.mp3')
const fileB = path.join(dirB, 'clip_iso.mp3')
try { fs.unlinkSync(fileA) } catch (_) {}
try { fs.unlinkSync(fileB) } catch (_) {}

const canonical = buildTtsCacheInput({ provider: 'iso_tts', voice: 'v1', model: 'v1', text: 'xin chao isolation', speed: 1 })

// (c) execution → cacheHit:false, tạo file A
__clearInFlightForTests()
const rA1 = await callProvider({
  provider: 'iso_tts', type: 'tts', model: 'v1', input: canonical, userId: 'u1', projectId: projA, jobId: null,
  fn: async () => { fs.writeFileSync(fileA, Buffer.from('audio-A1')); return { audioPath: fileA, durationSec: 1.1, provider: 'iso_tts' } },
})
assert(rA1.cacheHit === false, 'execution returns cacheHit:false')
assert(rA1.audioPath === fileA, 'project A gets own path')

// (b) legacy unsafe: caller B cùng input nhưng cache đang giữ path của A → MISS, chạy lại, tạo file B
__clearInFlightForTests()
let bCalls = 0
const rB1 = await callProvider({
  provider: 'iso_tts', type: 'tts', model: 'v1', input: canonical, userId: 'u1', projectId: projB, jobId: null,
  fn: async () => { bCalls++; fs.writeFileSync(fileB, Buffer.from('audio-B1')); return { audioPath: fileB, durationSec: 1.2, provider: 'iso_tts' } },
})
assert(bCalls === 1, `cross-project unsafe cache → MISS + provider reruns (calls=${bCalls})`)
assert(rB1.audioPath === fileB, 'project B gets own path, not A path')
assert(rB1.audioPath !== fileA, 'B does not receive A local path')
assert(fs.existsSync(fileB), 'B file materialized separately')

// (a) concurrent A+B cùng input → mỗi bên file riêng, không leak chéo
try { fs.unlinkSync(fileA) } catch (_) {}
try { fs.unlinkSync(fileB) } catch (_) {}
await (await import('../src/db/query.js')).run('DELETE FROM provider_cache WHERE provider = ?', ['iso_tts2'])
const canon2 = buildTtsCacheInput({ provider: 'iso_tts2', voice: 'v1', model: 'v1', text: 'concurrent hello', speed: 1 })
__clearInFlightForTests()
const slowFn = (file, ms) => async () => {
  await new Promise((r) => setTimeout(r, ms))
  fs.writeFileSync(file, Buffer.from(`audio-${file}`))
  return { audioPath: file, durationSec: 1.0, provider: 'iso_tts2' }
}
const [cA, cB] = await Promise.all([
  callProvider({ provider: 'iso_tts2', type: 'tts', model: 'v1', input: canon2, userId: 'u1', projectId: projA, jobId: null, fn: slowFn(fileA, 150) }),
  callProvider({ provider: 'iso_tts2', type: 'tts', model: 'v1', input: canon2, userId: 'u1', projectId: projB, jobId: null, fn: slowFn(fileB, 150) }),
])
assert(cA.audioPath === fileA && cB.audioPath === fileB, 'concurrent A+B each keep own artifact path')
assert(cA.audioPath !== cB.audioPath, 'no cross-project audioPath reuse under concurrency')

// QA-CH: same-project DB-hit → cacheHit:true (file tồn tại, cùng owner).
// Reset row trước để tránh last-writer-wins từ pha concurrent cross-project (tradeoff đã document).
await (await import('../src/db/query.js')).run('DELETE FROM provider_cache WHERE provider = ?', ['iso_tts2'])
try { fs.unlinkSync(fileA) } catch (_) {}
__clearInFlightForTests()
const rA3 = await callProvider({
  provider: 'iso_tts2', type: 'tts', model: 'v1', input: canon2, userId: 'u1', projectId: projA, jobId: null,
  fn: async () => { fs.writeFileSync(fileA, Buffer.from('audio-A3')); return { audioPath: fileA, durationSec: 1.0, provider: 'iso_tts2' } },
})
assert(rA3.cacheHit === false, 're-established A entry is execution (cacheHit:false)')
__clearInFlightForTests()
const rA2 = await callProvider({
  provider: 'iso_tts2', type: 'tts', model: 'v1', input: canon2, userId: 'u1', projectId: projA, jobId: null,
  fn: async () => { throw new Error('should NOT be called on same-project cache hit') },
})
assert(rA2.cacheHit === true, 'same-project DB-hit returns cacheHit:true')
assert(rA2.audioPath === fileA, 'same-project HIT returns own path')

// cleanup project dirs (surgical: chỉ xóa file test, giữ thư mục)
try { fs.unlinkSync(fileA) } catch (_) {}
try { fs.unlinkSync(fileB) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
