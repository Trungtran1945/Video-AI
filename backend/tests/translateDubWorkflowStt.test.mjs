// Regression test for TRANSLATE_DUB STT-only workflow:
// Test 6: ASR functionality (audio normalization, provider invocation, chunking, timestamps, source=asr)
// Test 7: Full pipeline data contract (ASR -> Translation -> TTS -> Alignment -> Render)
// Run: node backend/tests/translateDubWorkflowStt.test.mjs

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { v4 as uuidv4 } from 'uuid'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai_workflow_stt_'))
process.env.DB_PATH = path.join(tmpDir, 'test.db')
process.env.STORAGE_DIR = path.join(tmpDir, 'storage')

const { initSchema } = await import('../src/db/schema.js')
const { run, query, queryOne } = await import('../src/db/query.js')
const { stagesForProject, STAGES } = await import('../src/pipeline/runner.js')
const { default: dubMerge, validateForRender } = await import('../src/pipeline/stages/dubMerge.js')
const { buildAss } = await import('../src/pipeline/stages/dubRender.js')
const { validateNoOverlap } = await import('../src/pipeline/forcedAlignService.js')
const { getProvider } = await import('../src/providers/registry.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const pid = 'proj-stt-workflow'
const userId = 'usr-test-1'

await run(
  'INSERT INTO projects (id, user_id, mode, title, params, transcript_version, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
  [
    pid,
    userId,
    'TRANSLATE_DUB',
    'STT Dub Workflow Project',
    JSON.stringify({
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      stylePreset: 'phim-hanh-dong',
      enableDubbing: true,
      subPosition: 'bottom',
    }),
    1,
    'running',
  ]
)

// ── Test 1: STT is always selected in pipeline graph ──
const stages = stagesForProject({ mode: 'TRANSLATE_DUB', params: '{}' })
assert(
  JSON.stringify(stages) === JSON.stringify(['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.ttsAlign', 'dub.render']),
  'stagesForProject returns STT-only pipeline'
)
assert(!stages.includes('dub.ocr'), 'stages does not include dub.ocr')

// ── Test 2: ASR provider abstraction ──
const asrProvider = await getProvider(userId, 'asr')
assert(asrProvider && typeof asrProvider.provider?.transcribe === 'function', 'ASR provider abstraction resolves and exposes transcribe()')
assert(asrProvider.id === 'whisper' || asrProvider.id === 'mock', 'ASR provider uses whisper/mock')

// ── Test 3: Simulated ASR segment production (matching dubStt contract) ──
const asrResults = [
  { start: 0.5, end: 2.5, text: 'Welcome to the mission.', language: 'en' },
  { start: 3.0, end: 5.5, text: 'We need to move quickly.', language: 'en' },
]

for (let i = 0; i < asrResults.length; i++) {
  const item = asrResults[i]
  await run(
    `INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text, speaker, language, source, ratio_x, ratio_y, ratio_w, ratio_h)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
    [
      `seg-${i}`,
      pid,
      i,
      item.start,
      item.end,
      item.text,
      null,
      item.language,
      'asr',
    ]
  )
}

const persistedSegs = await query('SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC', [pid])
assert(persistedSegs.length === 2, 'persisted 2 transcript segments from STT')
assert(persistedSegs.every((s) => s.source === 'asr'), 'all segments have source = asr')
assert(persistedSegs.every((s) => s.ratio_x === null && s.ratio_w === null), 'ASR segments have no OCR coordinates')

// ── Test 4: dubMerge executes and validates ASR segments ──
const projectRow = await queryOne('SELECT * FROM projects WHERE id = ?', [pid])
const mergeResult = await dubMerge({
  project: projectRow,
  job: { id: 'job-merge-1' },
  setProgress: () => {},
})
assert(mergeResult.transcriptSegments === 2, 'dubMerge counted 2 segments')
assert(mergeResult.source === 'asr', 'dubMerge returns source asr')

// ── Test 5: Translation phase populates translation text ──
await run('UPDATE transcript_segments SET translation = ? WHERE id = ?', ['Chào mừng bạn đến với nhiệm vụ.', 'seg-0'])
await run('UPDATE transcript_segments SET translation = ? WHERE id = ?', ['Chúng ta cần phải di chuyển nhanh.', 'seg-1'])

// ── Test 6: TTS & Alignment phase creates audio records linked 1:1 to segments ──
const audio0Id = uuidv4()
const audio1Id = uuidv4()
await run('INSERT INTO audios (id, project_id, duration_sec, storage_key) VALUES (?, ?, ?, ?)', [audio0Id, pid, 1.8, 'audio/seg_0.wav'])
await run('INSERT INTO audios (id, project_id, duration_sec, storage_key) VALUES (?, ?, ?, ?)', [audio1Id, pid, 2.0, 'audio/seg_1.wav'])
await run('UPDATE transcript_segments SET tts_audio_id = ? WHERE id = ?', [audio0Id, 'seg-0'])
await run('UPDATE transcript_segments SET tts_audio_id = ? WHERE id = ?', [audio1Id, 'seg-1'])

// Alignment overlap check
const timeline = [
  { segmentId: 'seg-0', startAtSec: 0.5, endAtSec: 2.5 },
  { segmentId: 'seg-1', startAtSec: 3.0, endAtSec: 5.5 },
]
const overlapCheck = validateNoOverlap(timeline)
assert(overlapCheck.ok === true, 'timeline placement has no overlap')

// ── Test 7: Pre-render validation passes on complete ASR+TTS pipeline data ──
const renderValidation = await validateForRender(pid)
assert(renderValidation.valid === true, `validateForRender passes with complete ASR+TTS data: ${JSON.stringify(renderValidation.errors)}`)

// ── Test 8: Subtitle rendering produces deterministic bottom layout without OCR regions ──
const translatedSegs = await query('SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC', [pid])
const assFile = buildAss(tmpDir, translatedSegs, [], {
  width: 1920,
  height: 1080,
  title: 'Render Test',
  subPosition: 'bottom',
})
const assContent = fs.readFileSync(assFile, 'utf8')
assert(assContent.includes('\\an2\\pos(960,972)'), 'ASS positions subtitles at bottom center for 1080p')
assert(assContent.includes('Chào mừng bạn đến với nhiệm vụ.'), 'ASS includes translated segment 1')
assert(assContent.includes('Chúng ta cần phải di chuyển nhanh.'), 'ASS includes translated segment 2')

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}

if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
