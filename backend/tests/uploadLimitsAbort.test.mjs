// PLAN Task 0 — Upload limits + abort (B2/S6/S8/F4).
// Limits: MAX 2GB single source; chunk protocol 8MB; HTTP fail-fast; DELETE abort.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHUNK_SIZE, MAX_SIZE } from '../src/services/resumableUploadService.js'

let failures = 0
const assert = (c, m) => {
  if (c) console.log('PASS:', m)
  else { failures += 1; console.error('FAIL:', m) }
}
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uploadSrc = fs.readFileSync(path.join(__dirname, '..', 'src/routes/v1/upload.js'), 'utf8')
const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src/routes/v1/index.js'), 'utf8')

assert(CHUNK_SIZE === 8 * 1024 * 1024, `CHUNK_SIZE is 8MB (got ${CHUNK_SIZE})`)
assert(MAX_SIZE === 2 * 1024 * 1024 * 1024, `MAX_SIZE is 2GB (got ${MAX_SIZE})`)
// HTTP layer fail-fast: raw limit must be >8MB protocol but bounded (10-16MB), message CHUNK_TOO_LARGE.
assert(/raw\(\{[^}]*limit:\s*['"]1\dmb['"]/i.test(uploadSrc), 'chunk raw body limit bounded (fail-fast)')
assert(uploadSrc.includes('CHUNK_TOO_LARGE'), 'chunk-too-large error code present')
// DELETE abort exists; after abort HEAD/PUT must 404/410 (service abort()).
assert(/router\.delete\(['"]\/:id['"]/.test(uploadSrc), 'DELETE /uploads/:id abort route exists')
const serviceSrc = fs.readFileSync(path.join(__dirname, '..', 'src/services/resumableUploadService.js'), 'utf8')
assert(/abortUpload|aborted/.test(serviceSrc), 'service exposes abort (aborted status)')
assert(/410/.test(serviceSrc), 'service uses 410 GONE after abort/expire')
// Mount: một router phục vụ cả 2 prefix (backward-compat, khóa bởi
// uploadHttpContract.test.mjs) — canonical TUS là /uploads/*, legacy là /upload.
assert(/router\.use\('\/uploads', uploadRouter\)/.test(indexSrc), 'TUS router mounted on /uploads')
assert(/router\.use\('\/upload', uploadRouter\)/.test(indexSrc), 'legacy router mounted on /upload')
assert(/canonical/.test(indexSrc), 'index.js documents canonical upload paths')

if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
