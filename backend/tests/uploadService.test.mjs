import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-upload-service-'))
process.env.DB_PATH = path.join(tmpRoot, 'data.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'

const { initSchema } = await import('../src/db/schema.js')
const realDb = await import('../src/db/query.js')
let uploadModule = null
try {
  uploadModule = await import('../src/services/resumableUploadService.js')
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
async function rejectsCode(fn, code) {
  try {
    await fn()
    return false
  } catch (error) {
    return error?.code === code
  }
}
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return true
}
function mp4Bytes(size = 32) {
  const data = Buffer.alloc(size)
  data.writeUInt32BE(24, 0)
  data.write('ftyp', 4, 'ascii')
  data.write('isom', 8, 'ascii')
  data.write('test-payload', 12, 'ascii')
  return data
}

assert(Boolean(uploadModule), 'resumable upload service is available')
if (!uploadModule) process.exit(1)

const { UploadServiceError, createResumableUploadService, CHUNK_SIZE, MAX_SIZE } = uploadModule
const storageDir = process.env.STORAGE_DIR
const userId = 'upload-service-user'
const baseOptions = { storageDir, db: realDb, probe: null, ttlMs: 60 * 60 * 1000 }

const sameSessionService = createResumableUploadService(baseOptions)
const sameChunk = Buffer.from('same-session-chunk')
const sameSession = await sameSessionService.createSession({ userId, filename: 'same.mp4', size: sameChunk.length, mime: 'video/mp4' })
const sameResults = await Promise.allSettled(Array.from({ length: 100 }, () => sameSessionService.appendChunk({
  id: sameSession.uploadId,
  userId,
  offset: 0,
  chunk: sameChunk,
})))
const accepted = sameResults.filter((result) => result.status === 'fulfilled')
const conflicts = sameResults.filter((result) => result.status === 'rejected' && result.reason?.code === 'OFFSET_MISMATCH')
const sameBlob = path.join(storageDir, 'tmp', 'upload_sessions', sameSession.uploadId, 'blob')
assert(accepted.length === 1, `100 concurrent same-session chunks accept exactly once (got ${accepted.length})`)
assert(conflicts.length === 99, `99 duplicate same-offset requests conflict (got ${conflicts.length})`)
assert(fs.readFileSync(sameBlob).equals(sameChunk), 'same-session concurrent writes contain the chunk exactly once')

const aStarted = deferred()
const releaseA = deferred()
let blockA = true
const countingFs = {
  ...fs,
  promises: {
    ...fs.promises,
    async open(filePath, ...args) {
      if (blockA && String(filePath).includes('00000000-0000-4000-8000-00000000000a')) {
        blockA = false
        aStarted.resolve()
        await releaseA.promise
      }
      return fs.promises.open(filePath, ...args)
    },
  },
}
const parallelIds = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b']
let parallelIdIndex = 0
const parallelService = createResumableUploadService({ ...baseOptions, fileSystem: countingFs, uuid: () => parallelIds[parallelIdIndex++] })
const sessionA = await parallelService.createSession({ userId, filename: 'a.mp4', size: 8, mime: 'video/mp4' })
const sessionB = await parallelService.createSession({ userId, filename: 'b.mp4', size: 8, mime: 'video/mp4' })
const aWrite = parallelService.appendChunk({ id: sessionA.uploadId, userId, offset: 0, chunk: Buffer.alloc(8, 1) })
await aStarted.promise
let bFinished = false
const bWrite = parallelService.appendChunk({ id: sessionB.uploadId, userId, offset: 0, chunk: Buffer.alloc(8, 2) }).then(() => { bFinished = true })
const bCompletedWhileABlocked = await waitUntil(() => bFinished)
releaseA.resolve()
await Promise.all([aWrite, bWrite])
assert(bCompletedWhileABlocked, 'different upload sessions are not globally serialized')

const limitsService = createResumableUploadService(baseOptions)
const ancestorSymlinkFs = {
  ...fs,
  promises: {
    ...fs.promises,
    async lstat(filePath) {
      if (String(filePath).endsWith(`${path.sep}upload_sessions`)) {
        return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => true }
      }
      return fs.promises.lstat(filePath)
    },
  },
}
const ancestorId = '00000000-0000-4000-8000-000000000011'
const ancestorSymlinkService = createResumableUploadService({ ...baseOptions, fileSystem: ancestorSymlinkFs, uuid: () => ancestorId })
assert(await rejectsCode(() => ancestorSymlinkService.createSession({ userId, filename: 'ancestor.mp4', size: 8, mime: 'video/mp4' }), 'UPLOAD_PATH_UNSAFE'), 'session creation rejects a symlinked storage ancestor')
const ancestorRow = await realDb.queryOne('SELECT status FROM upload_sessions WHERE id = ?', [ancestorId])
assert(ancestorRow?.status === 'expired', 'unsafe session creation retires its provisional database row')
const componentMkdirCalls = []
const componentFs = {
  ...fs,
  promises: {
    ...fs.promises,
    async mkdir(directory, options) {
      componentMkdirCalls.push({ directory, options })
      return fs.promises.mkdir(directory, options)
    },
  },
}
const componentService = createResumableUploadService({ ...baseOptions, fileSystem: componentFs })
const componentSession = await componentService.createSession({ userId, filename: 'components.mp4', size: 8, mime: 'video/mp4' })
assert(componentMkdirCalls.length >= 3 && componentMkdirCalls.every((call) => call.options?.recursive !== true), 'resumable directories are created component-by-component without recursive mkdir')
assert(componentMkdirCalls.some((call) => String(call.directory).endsWith(path.join('tmp', 'upload_sessions'))) && componentMkdirCalls.some((call) => String(call.directory).endsWith(componentSession.uploadId)), 'resumable directory creation checks each canonical component')
const limitsSession = await limitsService.createSession({ userId, filename: 'limits.mp4', size: 32, mime: 'video/mp4' })
assert(await rejectsCode(() => limitsService.appendChunk({ id: limitsSession.uploadId, userId, offset: 0, chunk: Buffer.alloc(CHUNK_SIZE + 1) }), 'CHUNK_TOO_LARGE'), 'chunk larger than 8MiB is rejected')
assert(await rejectsCode(() => limitsService.appendChunk({ id: limitsSession.uploadId, userId, offset: 0, chunk: Buffer.alloc(33) }), 'CHUNK_EXCEEDS_REMAINING_SIZE'), 'chunk larger than declared remaining size is rejected')
assert(await rejectsCode(() => limitsService.createSession({ userId, filename: 'invalid.mp4', size: Number.MAX_SAFE_INTEGER + 1, mime: 'video/mp4' }), 'INVALID_UPLOAD_SIZE'), 'non-safe declared size is rejected')
assert(await rejectsCode(() => limitsService.createSession({ userId, filename: 'zero.mp4', size: 0, mime: 'video/mp4' }), 'INVALID_UPLOAD_SIZE'), 'zero declared size is rejected')
assert(await rejectsCode(() => limitsService.createSession({ userId, filename: 'large.mp4', size: MAX_SIZE + 1, mime: 'video/mp4' }), 'PAYLOAD_TOO_LARGE'), 'declared size above 2GiB is rejected')

let failChunkCommit = true
const failingDb = {
  ...realDb,
  async runAffected(sql, params, options) {
    if (failChunkCommit && sql.includes('bytes_received = ?') && sql.includes("status = 'pending'")) {
      failChunkCommit = false
      throw new Error('forced chunk commit failure')
    }
    return realDb.runAffected(sql, params, options)
  },
}
const recoveryService = createResumableUploadService({ ...baseOptions, db: failingDb })
const recoveryChunk = Buffer.from('recoverable-chunk')
const recoverySession = await recoveryService.createSession({ userId, filename: 'recovery.mp4', size: recoveryChunk.length, mime: 'video/mp4' })
assert(await rejectsCode(() => recoveryService.appendChunk({ id: recoverySession.uploadId, userId, offset: 0, chunk: recoveryChunk }), 'INTERNAL_ERROR'), 'append failure after filesystem write is surfaced')
const recoveryBlob = path.join(storageDir, 'tmp', 'upload_sessions', recoverySession.uploadId, 'blob')
assert(fs.statSync(recoveryBlob).size === recoveryChunk.length, 'failed DB commit leaves a detectable uncommitted file tail')
await recoveryService.appendChunk({ id: recoverySession.uploadId, userId, offset: 0, chunk: recoveryChunk })
const recoveryRow = await realDb.queryOne('SELECT bytes_received FROM upload_sessions WHERE id = ?', [recoverySession.uploadId])
assert(Number(recoveryRow.bytes_received) === recoveryChunk.length && fs.readFileSync(recoveryBlob).equals(recoveryChunk), 'retry truncates the uncommitted tail and commits exactly once')

let renameCount = 0
const completionFs = {
  ...fs,
  promises: {
    ...fs.promises,
    async rename(...args) {
      renameCount += 1
      return fs.promises.rename(...args)
    },
  },
}
const completionService = createResumableUploadService({ ...baseOptions, fileSystem: completionFs })
const completionBytes = mp4Bytes(64)
const completionSession = await completionService.createSession({ userId, filename: 'complete.mp4', size: completionBytes.length, mime: 'video/mp4' })
await completionService.appendChunk({ id: completionSession.uploadId, userId, offset: 0, chunk: completionBytes })
const [completionA, completionB] = await Promise.all([
  completionService.complete({ id: completionSession.uploadId, userId }),
  completionService.complete({ id: completionSession.uploadId, userId }),
])
const repeatedCompletion = await completionService.complete({ id: completionSession.uploadId, userId })
assert(completionA.storageKey === completionB.storageKey && completionA.videoHash === completionB.videoHash, 'concurrent completes return the same storage key and hash')
assert(repeatedCompletion.storageKey === completionA.storageKey && repeatedCompletion.videoHash === completionA.videoHash, 'repeated complete is idempotent')
assert(renameCount === 1, `concurrent completion performs one physical rename (got ${renameCount})`)
assert(fs.existsSync(path.join(storageDir, completionA.storageKey)), 'completed file exists at its persisted storage key')
assert(!fs.existsSync(path.join(storageDir, 'tmp', 'upload_sessions', completionSession.uploadId, 'blob')), 'completed temp blob is removed')

const missingId = '00000000-0000-4000-8000-00000000000e'
const missingService = createResumableUploadService({ ...baseOptions, uuid: () => missingId })
const missingBytes = mp4Bytes(40)
const missingSession = await missingService.createSession({ userId, filename: 'missing.mp4', size: missingBytes.length, mime: 'video/mp4' })
await missingService.appendChunk({ id: missingId, userId, offset: 0, chunk: missingBytes })
const missingCompleted = await missingService.complete({ id: missingId, userId })
fs.rmSync(path.join(storageDir, missingCompleted.storageKey))
assert(await rejectsCode(() => missingService.complete({ id: missingId, userId }), 'UPLOAD_RECOVERY_FAILED'), 'completed retry detects a missing final file')

const corruptedId = '00000000-0000-4000-8000-00000000000f'
const corruptedService = createResumableUploadService({ ...baseOptions, uuid: () => corruptedId })
const corruptedBytes = mp4Bytes(44)
await corruptedService.createSession({ userId, filename: 'corrupted.mp4', size: corruptedBytes.length, mime: 'video/mp4' })
await corruptedService.appendChunk({ id: corruptedId, userId, offset: 0, chunk: corruptedBytes })
const corruptedCompleted = await corruptedService.complete({ id: corruptedId, userId })
const corruptedPath = path.join(storageDir, corruptedCompleted.storageKey)
const corruptedData = fs.readFileSync(corruptedPath)
corruptedData[corruptedData.length - 1] ^= 0xff
fs.writeFileSync(corruptedPath, corruptedData)
assert(await rejectsCode(() => corruptedService.complete({ id: corruptedId, userId }), 'UPLOAD_RECOVERY_FAILED'), 'completed retry detects same-size final corruption')

const crashId = '00000000-0000-4000-8000-00000000000c'
const crashService = createResumableUploadService({ ...baseOptions, uuid: () => crashId })
const crashBytes = mp4Bytes(48)
const crashSession = await crashService.createSession({ userId, filename: 'crash.mp4', size: crashBytes.length, mime: 'video/mp4' })
await crashService.appendChunk({ id: crashId, userId, offset: 0, chunk: crashBytes })
const crashTemp = path.join(storageDir, 'tmp', 'upload_sessions', crashId, 'blob')
const crashFinalKey = `uploads/${crashId}.mp4`
const crashFinal = path.join(storageDir, crashFinalKey)
const crashHash = crypto.createHash('sha256').update(crashBytes).digest('hex')
fs.mkdirSync(path.dirname(crashFinal), { recursive: true })
fs.renameSync(crashTemp, crashFinal)
await realDb.run("UPDATE upload_sessions SET status = 'completing', storage_key = ?, video_hash = ? WHERE id = ?", [crashFinalKey, crashHash, crashId])
const startupRecovery = await createResumableUploadService(baseOptions).recoverUploadSessions()
const recoveredCrash = await realDb.queryOne('SELECT status, storage_key, video_hash FROM upload_sessions WHERE id = ?', [crashId])
assert(startupRecovery.recovered === 1 && recoveredCrash.status === 'completed', 'startup recovery completes a persisted final file')
assert(recoveredCrash.storage_key === crashFinalKey && recoveredCrash.video_hash === crashHash, 'startup recovery preserves final key and hash')

const tamperId = '00000000-0000-4000-8000-000000000010'
const tamperService = createResumableUploadService({ ...baseOptions, uuid: () => tamperId })
const tamperBytes = mp4Bytes(52)
await tamperService.createSession({ userId, filename: 'tamper.mp4', size: tamperBytes.length, mime: 'video/mp4' })
await tamperService.appendChunk({ id: tamperId, userId, offset: 0, chunk: tamperBytes })
const tamperHash = crypto.createHash('sha256').update(tamperBytes).digest('hex')
const tamperFinalKey = `uploads/${tamperId}.mp4`
const tamperBlob = path.join(storageDir, 'tmp', 'upload_sessions', tamperId, 'blob')
const tampered = fs.readFileSync(tamperBlob)
tampered[tampered.length - 1] ^= 0xff
fs.writeFileSync(tamperBlob, tampered)
await realDb.run("UPDATE upload_sessions SET status = 'completing', storage_key = ?, video_hash = ? WHERE id = ?", [tamperFinalKey, tamperHash, tamperId])
const tamperRecovery = await createResumableUploadService({ ...baseOptions, probe: null }).recoverUploadSessions()
const tamperRow = await realDb.queryOne('SELECT status FROM upload_sessions WHERE id = ?', [tamperId])
assert(tamperRecovery.failed === 1 && tamperRow.status === 'completing', 'startup recovery rejects a same-size tampered temp blob')
assert(!fs.existsSync(path.join(storageDir, tamperFinalKey)), 'tampered temp blob is never promoted to a final file')

const expiredService = createResumableUploadService(baseOptions)
const expired = await expiredService.createSession({ userId, filename: 'expired.mp4', size: 8, mime: 'video/mp4' })
await realDb.run('UPDATE upload_sessions SET expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', expired.uploadId])
const cleanupResult = await expiredService.cleanupExpiredUploadSessions()
const expiredRow = await realDb.queryOne('SELECT status FROM upload_sessions WHERE id = ?', [expired.uploadId])
assert(cleanupResult.cleaned === 1 && expiredRow.status === 'expired', 'expired pending session is marked expired')
assert(!fs.existsSync(path.join(storageDir, 'tmp', 'upload_sessions', expired.uploadId)), 'expired session temp directory is deleted')

const active = await expiredService.createSession({ userId, filename: 'active.mp4', size: 8, mime: 'video/mp4' })
await expiredService.cleanupExpiredUploadSessions()
const activeRow = await realDb.queryOne('SELECT status FROM upload_sessions WHERE id = ?', [active.uploadId])
assert(activeRow.status === 'pending', 'active upload session is not cleaned')

const unsafeCompletedId = '00000000-0000-4000-8000-00000000000d'
await realDb.run("INSERT INTO upload_sessions (id, user_id, filename, size, mime, bytes_received, status, storage_key, video_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
  unsafeCompletedId, userId, 'unsafe.mp4', 6, 'video/mp4', 6, 'completed', '../outside', null,
])
assert(await rejectsCode(() => expiredService.complete({ id: unsafeCompletedId, userId }), 'UPLOAD_RECOVERY_FAILED'), 'completed retry rejects an unsafe storage key')

const outside = path.join(tmpRoot, 'outside.bin')
fs.writeFileSync(outside, 'keep')
await realDb.run("INSERT INTO upload_sessions (id, user_id, filename, size, mime, bytes_received, status, tmp_path, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
  '../outside', userId, 'outside.mp4', 6, 'video/mp4', 0, 'pending', outside, '2000-01-01T00:00:00.000Z',
])
await expiredService.cleanupExpiredUploadSessions()
const traversalRow = await realDb.queryOne('SELECT status FROM upload_sessions WHERE id = ?', ['../outside'])
assert(fs.existsSync(outside), 'cleanup never follows a malicious tmp_path outside the canonical session root')
assert(traversalRow.status === 'expired', 'malformed expired session id is retired without filesystem access')

const completedExpired = await realDb.queryOne('SELECT storage_key FROM upload_sessions WHERE id = ?', [completionSession.uploadId])
await realDb.run('UPDATE upload_sessions SET expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', completionSession.uploadId])
await expiredService.cleanupExpiredUploadSessions()
const completedStillExists = fs.existsSync(path.join(storageDir, completedExpired.storage_key))
assert(completedStillExists, 'cleanup never deletes completed upload files')

if (failures > 0) process.exit(1)
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log('ALL PASS')
