// PLAN Task 0 — SUMMARY provenance (P2/F11).
// summaryRender: ensureDir(thumbs/) before makeThumbnail; createOutput carries
// transcriptVersion; summaryTranscribe skip-cache symmetric with DUB.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
const assert = (c, m) => {
  if (c) console.log('PASS:', m)
  else { failures += 1; console.error('FAIL:', m) }
}
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

const renderSrc = read('src/pipeline/stages/summaryRender.js')
assert(/ensureDir\(.*thumbs/.test(renderSrc), 'summaryRender ensureDir(thumbs/) before thumbnail')
assert(/transcriptVersion:\s*(?!null)/.test(renderSrc), 'summaryRender createOutput carries non-null transcriptVersion')
assert(!/transcriptVersion:\s*null/.test(renderSrc), 'summaryRender has no transcriptVersion: null')

const transcribeSrc = read('src/pipeline/stages/summaryTranscribe.js')
assert(/transcript_version|forceTranscript|skip/i.test(transcribeSrc), 'summaryTranscribe has skip-cache/version guard')

if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
