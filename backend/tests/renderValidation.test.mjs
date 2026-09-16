// Task 3 render validation policy A: required = text non-empty, OCR noise excluded,
// UNTRANSLATED dubbing=false -> SUBTITLE_SKIPPED warning, semantic hard -> SEMANTIC_BLOCK.
// Run: node backend/tests/renderValidation.test.mjs
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_renderval_${Date.now()}.db`)
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const { initSchema } = await import('../src/db/schema.js')
const { insert, query } = await import('../src/db/query.js')
const { validateForRender } = await import('../src/pipeline/stages/dubMerge.js')

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

const projectId = 'proj-render-val'
const paramsNoDub = JSON.stringify({ sourceLanguage: 'zh', targetLanguage: 'vi', enableDubbing: false })

await insert('projects', {
  id: projectId,
  user_id: 'user-1',
  mode: 'TRANSLATE_DUB',
  title: 'Render validation',
  status: 'running',
  params: paramsNoDub,
})

async function addSeg({ id, index, start, end, text, translation }) {
  await insert('transcript_segments', {
    id, project_id: projectId, index_num: index,
    start_sec: start, end_sec: end, text, translation,
  })
}

// seg0 valid zh->vi, seg1 OCR noise (text rỗng), seg2 thiếu translation
await addSeg({ id: 'seg0', index: 0, start: 0, end: 1.8, text: '你好世界', translation: 'xin chào thế giới' })
await addSeg({ id: 'seg1', index: 1, start: 2, end: 3.8, text: '', translation: '' })
await addSeg({ id: 'seg2', index: 2, start: 4, end: 5.8, text: '谢谢', translation: '' })

let v = await validateForRender(projectId)
assert(v.valid === true, 'dubbing=false + 1 missing translation -> valid (partial render)')
assert((v.errors || []).length === 0, 'errors rỗng khi dubbing=false và chỉ thiếu translation')
assert((v.warnings || []).some((w) => w.code === 'SUBTITLE_SKIPPED'), 'warnings có SUBTITLE_SKIPPED')
const skip = (v.warnings || []).find((w) => w.code === 'SUBTITLE_SKIPPED')
assert(skip && skip.segmentIds.includes('seg2'), 'SUBTITLE_SKIPPED chỉ rõ seg2')
assert(skip && !skip.segmentIds.includes('seg1'), 'OCR noise seg1 (text rỗng) loại khỏi yêu cầu')
assert(skip && Array.isArray(skip.details) && skip.details.some((d) => d.sourceLanguage === 'zh' && d.targetLanguage === 'vi'), 'warning details có sourceLanguage/targetLanguage')

// Thêm seg3 semantic hard: number mismatch
await addSeg({ id: 'seg3', index: 3, start: 6, end: 7.8, text: 'I have 2 apples', translation: 'Tôi có 3 quả táo' })
v = await validateForRender(projectId)
assert(v.valid === false, 'semantic hard -> valid=false')
const block = (v.errors || []).find((e) => e.code === 'SEMANTIC_BLOCK')
assert(!!block, 'errors có SEMANTIC_BLOCK')
assert(block && /segment #3/.test(block.message), 'SEMANTIC_BLOCK chỉ rõ index seg3')
assert(block && block.segmentIds.includes('seg3') && !block.segmentIds.includes('seg0'), 'SEMANTIC_BLOCK chỉ seg3, không lan sang seg0 valid')

// dubbing=true cùng data -> hard (UNTRANSLATED và/hoặc MISSING_TTS_AUDIO)
await query('UPDATE projects SET params = ? WHERE id = ?', [
  JSON.stringify({ sourceLanguage: 'zh', targetLanguage: 'vi', enableDubbing: true }),
  projectId,
])
v = await validateForRender(projectId)
assert(v.valid === false, 'dubbing=true cùng data -> valid=false')
assert(
  v.errors.some((e) => e.code === 'UNTRANSLATED_SEGMENTS') || v.errors.some((e) => e.code === 'MISSING_TTS_AUDIO'),
  'dubbing=true -> UNTRANSLATED hard và/hoặc MISSING_TTS_AUDIO'
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
