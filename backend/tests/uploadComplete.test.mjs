// Regression test: upload complete must calculate videoHash BEFORE using it.
// Bug was: `video_hash: videoHash` inside updateById() ran before
// `const videoHash = await ...` -> ReferenceError (TDZ).
// Expected order: rename file -> sha256 hash -> updateById -> respond.
// Run: node backend/tests/uploadComplete.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'v1', 'upload.js'), 'utf8')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// Isolate the complete handler to avoid matching unrelated code.
const completeIdx = src.indexOf('/complete')
assert(completeIdx !== -1, 'complete handler exists')
const body = src.slice(completeIdx)

const useIdx = body.indexOf('video_hash: videoHash')
const declIdx = Math.min(
  ...['const videoHash =', 'let videoHash ='].map((s) => body.indexOf(s)).filter((i) => i !== -1),
)
assert(useIdx !== -1, 'updateById persists video_hash')
assert(declIdx !== -1, 'videoHash is calculated (sha256)')
assert(declIdx !== -1 && useIdx !== -1 && declIdx < useIdx,
  'videoHash is declared BEFORE it is used in updateById (no TDZ)')

const renameIdx = body.indexOf('rename(tmpPath')
const hashIdx = body.indexOf("createHash('sha256')")
const updateIdx = body.indexOf("updateById('upload_sessions'")
assert(renameIdx !== -1 && hashIdx !== -1 && updateIdx !== -1, 'rename/hash/update steps exist')
assert(renameIdx < hashIdx && hashIdx < updateIdx,
  'order is rename -> sha256 -> updateById')

// Response must still expose videoHash.
assert(body.includes('videoHash,') || body.includes('videoHash:'), 'response includes videoHash')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
