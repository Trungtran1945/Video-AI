// Test cho stage dub.merge (docs/01 §5.1):
// Kiểm tra barrier: dub.merge chỉ SUCCESS khi cả dub.stt & dub.ocr đã thành công
// và TranscriptSegment[] + OcrRegion[] đều có trong DB.
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

async function setup(sttStatus, ocrStatus, withTranscript, withOcr) {
  await insert('projects', {
    id: projectId,
    user_id: 'user-1',
    mode: 'TRANSLATE_DUB',
    title: 'Test dub.merge',
    status: 'running',
  })
  await insert('generation_jobs', { id: uuidv4(), project_id: projectId, type: 'dub.stt', status: sttStatus })
  await insert('generation_jobs', { id: uuidv4(), project_id: projectId, type: 'dub.ocr', status: ocrStatus })
  await insert('generation_jobs', { id: uuidv4(), project_id: projectId, type: 'dub.merge', status: 'pending' })
  if (withTranscript) {
    await insert('transcript_segments', {
      id: uuidv4(), project_id: projectId, index_num: 0, start_sec: 0, end_sec: 1, text: 'hello',
    })
  }
  if (withOcr) {
    await insert('ocr_regions', {
      id: uuidv4(), project_id: projectId, start_sec: 0, end_sec: 1, ratio_x: 0.1, ratio_y: 0.8, ratio_w: 0.5, ratio_h: 0.1,
    })
  }
  const mergeJob = await queryOne('SELECT * FROM generation_jobs WHERE project_id = ? AND type = ?', [projectId, 'dub.merge'])
  return mergeJob
}

async function cleanup() {
  await query('DELETE FROM projects WHERE id = ?', [projectId])
  await query('DELETE FROM generation_jobs WHERE project_id = ?', [projectId])
  await query('DELETE FROM transcript_segments WHERE project_id = ?', [projectId])
  await query('DELETE FROM ocr_regions WHERE project_id = ?', [projectId])
  await query('DELETE FROM provider_logs WHERE project_id = ?', [projectId])
}

// Test 1: đủ cả transcript + ocr + cả 2 job con success → dub.merge SUCCESS
await cleanup()
const job1 = await setup('success', 'success', true, true)
const ctx1 = { project: { id: projectId }, job: job1, setProgress: () => {} }
let result1
try {
  result1 = await dubMerge(ctx1)
  assert(result1.transcriptSegments === 1 && result1.ocrRegions === 1, 'dub.merge trả về đúng số segment/region khi đủ data')
} catch (e) {
  assert(false, `dub.merge không nên throw khi đủ data: ${e.message}`)
}

// Test 2: thiếu transcript → throw lỗi
await cleanup()
const job2 = await setup('success', 'success', false, true)
const ctx2 = { project: { id: projectId }, job: job2, setProgress: () => {} }
try {
  await dubMerge(ctx2)
  assert(false, 'dub.merge phải throw khi thiếu TranscriptSegment')
} catch (e) {
  assert(/Thiếu TranscriptSegment/.test(e.message), `dub.merge throw đúng khi thiếu transcript: ${e.message}`)
}

// Test 3: thiếu ocr → throw lỗi
await cleanup()
const job3 = await setup('success', 'success', true, false)
const ctx3 = { project: { id: projectId }, job: job3, setProgress: () => {} }
try {
  await dubMerge(ctx3)
  assert(false, 'dub.merge phải throw khi thiếu OcrRegion')
} catch (e) {
  assert(/Thiếu OcrRegion/.test(e.message), `dub.merge throw đúng khi thiếu ocr: ${e.message}`)
}

// Test 4: dub.stt chưa success → throw lỗi
await cleanup()
const job4 = await setup('failed', 'success', true, true)
const ctx4 = { project: { id: projectId }, job: job4, setProgress: () => {} }
try {
  await dubMerge(ctx4)
  assert(false, 'dub.merge phải throw khi dub.stt không success')
} catch (e) {
  assert(/dub\.stt không thành công/.test(e.message), `dub.merge throw đúng khi dub.stt failed: ${e.message}`)
}

// Test 5: dub.ocr chưa success → throw lỗi
await cleanup()
const job5 = await setup('success', 'failed', true, true)
const ctx5 = { project: { id: projectId }, job: job5, setProgress: () => {} }
try {
  await dubMerge(ctx5)
  assert(false, 'dub.merge phải throw khi dub.ocr không success')
} catch (e) {
  assert(/dub\.ocr không thành công/.test(e.message), `dub.merge throw đúng khi dub.ocr failed: ${e.message}`)
}

await cleanup()

// Test 6: provider_logs có log 'ok' cho dub.merge (kiểm tra track)
await setup('success', 'success', true, true)
const jobMerge = await queryOne('SELECT * FROM generation_jobs WHERE project_id = ? AND type = ?', [projectId, 'dub.merge'])
const projectRow = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
await dubMerge({ project: projectRow, job: jobMerge, setProgress: () => {} })
const log = await queryOne('SELECT * FROM provider_logs WHERE project_id = ?', [projectId])
assert(log && log.status === 'ok', 'dub.merge ghi ProviderLog status=ok')
await cleanup()

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
