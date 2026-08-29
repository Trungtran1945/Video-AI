// Regression test cho lỗi "dịch chỉ được vài câu": JSON trả về bị cắt ngắn
// (truncation) nên chỉ vài câu đầu có bản dịch, còn lại mất thầm lặng.
// Test mock LLM provider, KHÔNG cần API key.
// Chạy: node tests/dubTranslate.backfill.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Phải set env TRƯỚC khi import (module ffmpeg.js chạy resolveBin tại load time).
process.env.DB_PATH = path.join(os.tmpdir(), `vidai_test_${Date.now()}.db`)
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const { initSchema } = await import('../src/db/schema.js')
const { translateGroup } = await import('../src/pipeline/stages/dubTranslate.js')

await initSchema()

const job = { id: 'test-job' }
const projectId = 'test-project'
const system = 'system'

// LLM giả: gọi lần 1 trả về CHỈ 2/5 câu (mô phỏng truncation), lần 2 bù đủ 3 câu còn lại.
function makeFakeLlm() {
  let callCount = 0
  return {
    id: 'fake',
    provider: {
      async complete({ prompt }) {
        callCount++
        let payload
        if (callCount === 1) {
          payload = { segments: [
            { index: 0, translation: 'Chào bạn' },
            { index: 1, translation: 'Tên tôi là A' },
          ] }
        } else {
          const missing = (prompt.match(/CHƯA được dịch[^:]*:\s*([\d,\s]+)/) || [])[1] || ''
          const idxs = missing.split(',').map((s) => s.trim()).filter(Boolean).map(Number)
          payload = { segments: idxs.map((i) => ({ index: i, translation: `dịch ${i}` })) }
        }
        return { text: JSON.stringify(payload), model: 'fake', usage: { tokensIn: 10, tokensOut: 10 } }
      },
    },
    _callCount: () => callCount,
  }
}

function makePrompt(indexes) {
  return indexes.map((i) => `${i}|0-1|câu gốc ${i}`).join('\n')
}

const indexes = [0, 1, 2, 3, 4]
const llm = makeFakeLlm()
const collected = await translateGroup(llm, system, makePrompt(indexes), job, projectId, {
  requiredIndexes: indexes,
  maxOutputTokens: 4096,
})

console.log('collected size:', collected.size, 'calls:', llm._callCount())
console.log('entries:', [...collected.entries()])

const ok = collected.size === 5 && indexes.every((i) => collected.has(i))
if (!ok) {
  console.error('FAIL: thiếu bản dịch cho các index:', indexes.filter((i) => !collected.has(i)))
  fs.rmSync(process.env.DB_PATH, { force: true })
  process.exit(1)
}
console.log('PASS: translateGroup bù đủ mọi câu bị thiếu (backfill hoạt động)')
fs.rmSync(process.env.DB_PATH, { force: true })
process.exit(0)
