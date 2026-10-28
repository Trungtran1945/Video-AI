// PLAN Task 0 — SSE closes on cancelled (F2/S3).
// cancelled is terminal: re-check must send terminal + close, never heartbeat forever.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
const assert = (c, m) => {
  if (c) console.log('PASS:', m)
  else { failures += 1; console.error('FAIL:', m) }
}
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/v1/events.js'), 'utf8')

assert(src.includes('cancelled'), 'events.js handles cancelled')
// DB re-check terminal list must include cancelled (not just completed/failed).
assert(
  /\[\s*['"]completed['"]\s*,\s*['"](failed|success)['"][\s\S]{0,80}cancelled|cancelled[\s\S]{0,80}(completed|failed)/.test(src),
  'DB re-check terminal list includes cancelled'
)
// eventBus listener terminal list must include cancelled.
assert(
  /payload\.status[\s\S]{0,120}cancelled|cancelled[\s\S]{0,120}payload\.status/.test(src),
  'eventBus listener treats cancelled as terminal'
)

if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
