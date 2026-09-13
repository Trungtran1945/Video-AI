// Test cho stage dub.merge:
// Kiểm tra barrier: transcript exists, translation filled, duration valid, language config present
// Chạy: node tests/dubMerge.test.mjs
import path from 'node:path'
import os from 'node:os'
import { v4 as uuidv4 } from 'uuid'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_dubmerge_${Date.now()}.db`)
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const { initSchema } = await import('../src/db/schema.js')
const { insert, updateById, query, queryOne } = await import('../src/db/query.js')
const dubMerge = (await import('../src/pipeline/stages/dubMerge.js')).default

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

const projectId = 'proj-merge-test'

async function setup({ withTranscript = false, translation = 'hello', startSec = 0, endSec = 1, params = '{}' } = {}) {
  await insert('projects', {
    id: projectId,
    user_id: 'user-1',
    mode: 'TRANSLATE_DUB',
    title: 'Test dub.merge',
    status: 'running',
    params,
  })
  await insert('generation_jobs', { id: uuidv4(), project_id: projectId, type: 'dub.stt', status: 'success' })
  await insert('generation_jobs', { id: uuidv4(), project_id: projectId, type: 'dub.merge', status: 'pending' })
  if (withTranscript) {
    await insert('transcript_segments', {
      id: uuidv4(), project_id: projectId, index_num: 0, start_sec: startSec, end_sec: endSec, text: 'hello', translation,
    })
  }
  const mergeJob = await queryOne('SELECT * FROM generation_jobs WHERE project_id = ? AND type = ?', [projectId, 'dub.merge'])
  return mergeJob
}

async function cleanup() {
  await query('DELETE FROM projects WHERE id = ?', [projectId])
  await query('DELETE FROM generation_jobs WHERE project_id = ?', [projectId])
  await query('DELETE FROM transcript_segments WHERE project_id = ?', [projectId])
  await query('DELETE FROM provider_logs WHERE project_id = ?', [projectId])
}

const defaultParams = JSON.stringify({ sourceLanguage: 'en', targetLanguage: 'vi' })

// Test 1: happy path — segments with translation, valid duration, language config → success
await cleanup()
const job1 = await setup({ withTranscript: true, translation: 'xin chào', params: defaultParams })
const ctx1 = { project: { id: projectId, params: defaultParams }, job: job1, setProgress: () => {} }
let result1
try {
  result1 = await dubMerge(ctx1)
  assert(result1.transcriptSegments === 1, 'dub.merge trả về đúng số segment khi đủ data')
} catch (e) {
  assert(false, `dub.merge không nên throw khi đủ data: ${e.message}`)
}

// Test 2: missing transcript → throw
await cleanup()
const job2 = await setup({ withTranscript: false, params: defaultParams })
const ctx2 = { project: { id: projectId, params: defaultParams }, job: job2, setProgress: () => {} }
try {
  await dubMerge(ctx2)
  assert(false, 'dub.merge phải throw khi thiếu TranscriptSegment')
} catch (e) {
  assert(/Thiếu TranscriptSegment/.test(e.message), `dub.merge throw đúng khi thiếu transcript: ${e.message}`)
}

// Test 3: segment without translation → throw
await cleanup()
const job3 = await setup({ withTranscript: true, translation: '', params: defaultParams })
const ctx3 = { project: { id: projectId, params: defaultParams }, job: job3, setProgress: () => {} }
try {
  await dubMerge(ctx3)
  assert(false, 'dub.merge phải throw khi segment chưa có bản dịch')
} catch (e) {
  assert(/chưa có bản dịch/.test(e.message), `dub.merge throw đúng khi thiếu translation: ${e.message}`)
}

// Test 4: invalid duration (<=0) → throw
await cleanup()
const job4 = await setup({ withTranscript: true, translation: 'ok', startSec: 5, endSec: 5, params: defaultParams })
const ctx4 = { project: { id: projectId, params: defaultParams }, job: job4, setProgress: () => {} }
try {
  await dubMerge(ctx4)
  assert(false, 'dub.merge phải throw khi duration <= 0')
} catch (e) {
  assert(/duration không hợp lệ/.test(e.message), `dub.merge throw đúng khi duration không hợp lệ: ${e.message}`)
}

// Test 5: invalid duration (>300) → throw
await cleanup()
const job5 = await setup({ withTranscript: true, translation: 'ok', startSec: 0, endSec: 301, params: defaultParams })
const ctx5 = { project: { id: projectId, params: defaultParams }, job: job5, setProgress: () => {} }
try {
  await dubMerge(ctx5)
  assert(false, 'dub.merge phải throw khi duration > 300')
} catch (e) {
  assert(/duration không hợp lệ/.test(e.message), `dub.merge throw đúng khi duration > 300s: ${e.message}`)
}

// Test 6: missing language config → throw
await cleanup()
const job6 = await setup({ withTranscript: true, translation: 'ok', params: '{}' })
const ctx6 = { project: { id: projectId, params: '{}' }, job: job6, setProgress: () => {} }
try {
  await dubMerge(ctx6)
  assert(false, 'dub.merge phải throw khi thiếu language config')
} catch (e) {
  assert(/sourceLanguage hoặc targetLanguage/.test(e.message), `dub.merge throw đúng khi thiếu language config: ${e.message}`)
}

// Test 7: provider_logs có log 'ok' cho dub.merge
await cleanup()
const job7 = await setup({ withTranscript: true, translation: 'xin chào', params: defaultParams })
const projectRow = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
await dubMerge({ project: projectRow, job: job7, setProgress: () => {} })
const log = await queryOne('SELECT * FROM provider_logs WHERE project_id = ?', [projectId])
assert(log && log.status === 'ok', 'dub.merge ghi ProviderLog status=ok')
await cleanup()

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
