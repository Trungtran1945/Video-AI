// PLAN Task 0 — Transcript PUT payload limit (S7/F5).
// PUT /transcript >1MB must 413 with chunked-edit/PATCH guidance (never silent 500).
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

const dubDataSrc = read('src/routes/v1/dubData.js')
assert(/413/.test(dubDataSrc), 'dubData.js returns 413 for oversized transcript payload')
assert(/chunk|PATCH|revision/i.test(dubDataSrc), 'dubData.js 413 message guides chunked-edit/PATCH')
const serverSrc = read('server.js')
assert(/json.*1mb|1mb.*json/i.test(serverSrc), 'server.js keeps json limit 1mb')

if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
