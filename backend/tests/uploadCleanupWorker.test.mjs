import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-upload-cleanup-worker-'))
process.env.DB_PATH = path.join(tmpRoot, 'data.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const db = await import('../src/db/query.js')
const { resumableUploadService } = await import('../src/services/resumableUploadService.js')
const { markLegacyUploadActive, releaseLegacyUpload } = await import('../src/services/legacyUploadRegistry.js')
let cleanupModule = null
try {
  cleanupModule = await import('../src/queue/workers/cleanupWorker.js')
} catch (_) {}

await initSchema()

let failures = 0
function assert(condition, message) {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

assert(typeof cleanupModule?.processCleanup === 'function', 'cleanup worker exports its processing function')
if (typeof cleanupModule?.processCleanup !== 'function') process.exit(1)

const userId = 'cleanup-worker-user'
const expired = await resumableUploadService.createSession({ userId, filename: 'expired.mp4', size: 8, mime: 'video/mp4' })
const active = await resumableUploadService.createSession({ userId, filename: 'active.mp4', size: 8, mime: 'video/mp4' })
await db.run('UPDATE upload_sessions SET expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', expired.uploadId])
const sessionRoot = path.join(process.env.STORAGE_DIR, 'tmp', 'upload_sessions')
const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
fs.utimesSync(sessionRoot, old, old)
fs.utimesSync(path.join(sessionRoot, active.uploadId), old, old)
const legacyRoot = path.join(process.env.STORAGE_DIR, 'tmp', 'legacy_uploads')
const activeLegacy = path.join(legacyRoot, 'active.upload')
const staleLegacy = path.join(legacyRoot, 'stale.upload')
fs.mkdirSync(legacyRoot, { recursive: true })
fs.writeFileSync(activeLegacy, 'active')
fs.writeFileSync(staleLegacy, 'stale')
fs.utimesSync(activeLegacy, old, old)
fs.utimesSync(staleLegacy, old, old)
markLegacyUploadActive(activeLegacy)

const result = await cleanupModule.processCleanup({})
const expiredRow = await db.queryOne('SELECT status FROM upload_sessions WHERE id = ?', [expired.uploadId])
const activeRow = await db.queryOne('SELECT status FROM upload_sessions WHERE id = ?', [active.uploadId])
assert(result.uploads?.cleaned === 1, 'cleanup worker reports expired upload count')
assert(result.legacyUploads?.cleaned === 1, 'cleanup worker reports stale legacy upload count')
assert(expiredRow.status === 'expired', 'cleanup worker expires stale upload sessions')
assert(activeRow.status === 'pending', 'cleanup worker preserves active upload sessions')
assert(fs.existsSync(path.join(sessionRoot, active.uploadId)), 'generic temp sweep never deletes active upload session directories')
assert(fs.existsSync(activeLegacy) && !fs.existsSync(staleLegacy), 'cleanup worker preserves active legacy staging and removes stale staging')
releaseLegacyUpload(activeLegacy)

fs.rmSync(tmpRoot, { recursive: true, force: true })
if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
