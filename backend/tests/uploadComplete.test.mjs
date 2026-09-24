import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-upload-complete-'))
process.env.DB_PATH = path.join(tmpRoot, 'data.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const realDb = await import('../src/db/query.js')
const { createResumableUploadService } = await import('../src/services/resumableUploadService.js')
await initSchema()

let failures = 0
function assert(condition, message) {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

const storageDir = process.env.STORAGE_DIR
let claimObserved = false
let claimedKey = null
let claimedHash = null
const observingDb = {
  ...realDb,
  async runAffected(sql, params, options) {
    const affected = await realDb.runAffected(sql, params, options)
    if (options?.op === 'claim.upload_completion' && affected === 1) {
      const row = await realDb.queryOne('SELECT id, status, storage_key, video_hash FROM upload_sessions WHERE id = ?', [params[3]])
      const tempPath = path.join(storageDir, 'tmp', 'upload_sessions', row.id, 'blob')
      const finalPath = path.join(storageDir, row.storage_key)
      claimObserved = row.status === 'completing'
        && Boolean(row.storage_key)
        && Boolean(row.video_hash)
        && fs.existsSync(tempPath)
        && !fs.existsSync(finalPath)
      claimedKey = row.storage_key
      claimedHash = row.video_hash
    }
    return affected
  },
}
const service = createResumableUploadService({ storageDir, db: observingDb, probe: null })
const bytes = Buffer.alloc(64)
bytes.writeUInt32BE(24, 0)
bytes.write('ftyp', 4, 'ascii')
bytes.write('isom', 8, 'ascii')
bytes.write('complete-order', 12, 'ascii')
const created = await service.createSession({ userId: 'complete-user', filename: 'complete.mp4', size: bytes.length, mime: 'video/mp4' })
await service.appendChunk({ id: created.uploadId, userId: 'complete-user', offset: 0, chunk: bytes })
const completed = await service.complete({ id: created.uploadId, userId: 'complete-user' })
assert(claimObserved, 'completion intent is durable before the temp file is moved')
assert(completed.storageKey === claimedKey, 'completed response uses the claimed storage key')
assert(completed.videoHash === claimedHash, 'completed response uses the claimed hash')
assert(claimedHash === crypto.createHash('sha256').update(bytes).digest('hex'), 'claimed hash matches uploaded bytes')
assert(fs.existsSync(path.join(storageDir, completed.storageKey)), 'final file exists after completion')

fs.rmSync(tmpRoot, { recursive: true, force: true })
if (failures > 0) process.exit(1)
console.log('ALL PASS')
