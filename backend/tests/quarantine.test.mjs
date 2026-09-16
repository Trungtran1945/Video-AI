// Quarantine: hard-fail lưu details để sửa tay, fail fast không retry.
// Run: node backend/tests/quarantine.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// DB cách ly (không chạm DB dev thật): persistTranslateReview ghi job.result.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-quar-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')

const mod = await import('../src/pipeline/stages/dubTranslate.js')
const { assertTranslateComplete, buildTranslateReviewDetails, persistTranslateReview } = mod
const runner = await import('../src/pipeline/runner.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// 1. assertTranslateComplete: mã NEEDS_REVIEW + giữ substring cũ cho test hiện tại.
{
  let msg = ''
  try {
    assertTranslateComplete(
      [{ id: 'a', text: 'hi' }, { id: 'b', text: 'hello' }],
      new Map([['a', 'xin chào']]),
      [1]
    )
  } catch (e) { msg = e.message }
  assert(msg.startsWith('TRANSLATE_NEEDS_REVIEW:'), 'quarantine error có mã TRANSLATE_NEEDS_REVIEW')
  assert(/incomplete: 1\/2/.test(msg), 'giữ substring incomplete X/Y (tương thích test cũ)')
  assert(/unresolved: 1/.test(msg), 'liệt kê segment unresolved')
  assert(/PATCH/.test(msg), 'hướng dẫn sửa tay trong message')
}

// 2. buildTranslateReviewDetails: đủ để sửa tay không cần chạy lại provider.
{
  const segments = [
    { id: 's0', index_num: 0, text: 'i have 2 apples' },
    { id: 's1', index_num: 1, text: 'good morning' },
  ]
  const gtResults = new Map([[0, 'tôi có 3 quả táo']])
  const styledAll = new Map([[0, 'tôi có 5 quả táo']])
  const d = buildTranslateReviewDetails(segments, [0], { gtResults, styledAll, targetLanguage: 'vi' })
  assert(d.length === 1, '1 detail cho 1 unresolved')
  assert(d[0].segmentId === 's0' && d[0].index === 0, 'detail gắn đúng segment')
  assert(d[0].source === 'i have 2 apples', 'detail giữ source')
  assert(d[0].base === 'tôi có 3 quả táo' && d[0].styled === 'tôi có 5 quả táo', 'detail giữ base+styled đã thử')
  assert(d[0].baseErrors.some((e) => e.startsWith('number mismatch')), 'detail có lỗi gate từng bản')
  assert(buildTranslateReviewDetails(segments, [], { gtResults }).length === 0, 'không unresolved -> [] (persist no-op)')
  const noStyle = buildTranslateReviewDetails(segments, [1], { gtResults, styledAll: null, targetLanguage: 'vi' })
  assert(noStyle[0].styled === null && noStyle[0].styledErrors === null, 'nhánh no-style: styled null')
  assert(noStyle[0].baseErrors.includes('missing base translation'), 'thiếu base -> missing marker rõ ràng')
}

// 3. persistTranslateReview: không throw khi job giả (test harness), false khi rỗng.
{
  const ok = await persistTranslateReview({ id: 'no-such-job' }, [{ index: 0 }])
  assert(ok === true || ok === false, 'persist best-effort không throw (got ' + ok + ')')
  assert((await persistTranslateReview({ id: 'x' }, [])) === false, 'details rỗng -> false')
  assert((await persistTranslateReview(null, [{ index: 0 }])) === false, 'job null -> false')
}

// 4. Runner fail-fast validation (không retry/backoff/park).
{
  assert(runner.isValidationError(new Error('TRANSLATE_NEEDS_REVIEW: dub.translate incomplete: 1/2')) === true, 'TRANSLATE_NEEDS_REVIEW là validation')
  assert(runner.isValidationError(new Error('BLOCK_RENDER: x')) === true, 'BLOCK_RENDER là validation')
  assert(runner.isValidationError(new Error('429 rate limit')) === false, 'rate-limit không phải validation')
  assert(runner.isValidationError(new Error('Cancelled')) === false, 'Cancelled không phải validation')
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pipeline', 'runner.js'), 'utf8')
  assert(src.includes('isValidationError(err)'), 'executeStage check validation trước rate-limit')
}

// 5. PATCH route sửa tay tồn tại + gate hard 422.
{
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes', 'v1', 'projects.js'), 'utf8')
  assert(src.includes("segments/:segmentId/translation"), 'PATCH segment translation route tồn tại')
  assert(src.includes('hasHardTranslationError'), 'PATCH route dùng semantic gate')
  assert(src.includes('422'), 'PATCH route 422 khi còn lỗi hard')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
// Teardown: đóng Redis handles (runner import kéo theo notifyQueue connection
// thật) — nếu không process abort lúc exit trên Windows (UV_HANDLE_CLOSING).
try {
  const { notifyQueue } = await import('../src/queue/notifyQueue.js')
  await notifyQueue.close().catch(() => {})
} catch (_) {}
try {
  const { connection } = await import('../src/queue/connection.js')
  connection.removeAllListeners('error')
  connection.disconnect()
} catch (_) {}
await new Promise((r) => setTimeout(r, 100))
process.exit(failures === 0 ? 0 : 1)
