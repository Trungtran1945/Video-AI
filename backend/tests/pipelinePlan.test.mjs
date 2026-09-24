import { stagesForProject } from '../src/pipeline/runner.js'

let failures = 0
const assert = (condition, message) => {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

const asr = stagesForProject({ mode: 'TRANSLATE_DUB', params: JSON.stringify({ ocrMode: false }) })
const ocr = stagesForProject({ mode: 'TRANSLATE_DUB', params: JSON.stringify({ ocrMode: true }) })
assert(asr.includes('dub.stt') && !asr.includes('dub.ocr'), 'ASR project selects dub.stt')
assert(ocr.includes('dub.ocr') && !ocr.includes('dub.stt'), 'OCR project selects dub.ocr')
assert(ocr.indexOf('dub.ocr') < ocr.indexOf('dub.merge'), 'OCR runs before dub.merge')
assert(asr.indexOf('dub.stt') < asr.indexOf('dub.merge'), 'ASR runs before dub.merge')

if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
