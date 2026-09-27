import { stagesForProject, flatStages, STAGES } from '../src/pipeline/runner.js'

let failures = 0
const assert = (condition, message) => {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

const expectedDubStages = [
  'dub.ingest',
  'dub.stt',
  'dub.merge',
  'dub.translate',
  'dub.ttsAlign',
  'dub.render',
]

// Test 1: STT is always selected for TRANSLATE_DUB
const defaultDub = stagesForProject({ mode: 'TRANSLATE_DUB', params: '{}' })
assert(
  JSON.stringify(defaultDub) === JSON.stringify(expectedDubStages),
  `TRANSLATE_DUB with empty params produces STT-only pipeline (${defaultDub.join(' -> ')})`
)

const ocrParamProject = stagesForProject({
  mode: 'TRANSLATE_DUB',
  params: JSON.stringify({ ocrMode: true }),
})
assert(
  JSON.stringify(ocrParamProject) === JSON.stringify(expectedDubStages),
  'params.ocrMode=true cannot switch the active pipeline to dub.ocr'
)
assert(!ocrParamProject.includes('dub.ocr'), 'pipeline does not contain dub.ocr even when ocrMode is true')
assert(ocrParamProject.includes('dub.stt'), 'pipeline contains dub.stt when ocrMode is true')

// Test 2: OCR stage is unreachable in TRANSLATE_DUB graph
assert(!STAGES.TRANSLATE_DUB.includes('dub.ocr'), 'STAGES.TRANSLATE_DUB does not include dub.ocr')
assert(STAGES.TRANSLATE_DUB.includes('dub.stt'), 'STAGES.TRANSLATE_DUB includes dub.stt')

const flat = flatStages('TRANSLATE_DUB')
assert(!flat.includes('dub.ocr'), 'flatStages does not include dub.ocr')
assert(flat.indexOf('dub.stt') === 1, 'dub.stt is stage index 1 (directly after dub.ingest)')
assert(flat.indexOf('dub.merge') === 2, 'dub.merge follows dub.stt')

// Verify SUMMARY mode is preserved unchanged
assert(STAGES.SUMMARY.length === 8, 'SUMMARY mode has 8 stages')
assert(STAGES.SUMMARY[0] === 'summary.transcribe', 'SUMMARY mode starts with summary.transcribe')

if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
