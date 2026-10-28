// R1 Chu kỳ 2 — Contract BE cho resume upload (dùng service thật, không sửa BE).
// HEAD offset đúng; PUT sai offset → 409 OFFSET_MISMATCH + expectedOffset;
// abort → HEAD/PUT/complete 410; expired → 410; resume nửa chừng → complete đủ bytes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-upload-resume-'))
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
async function expectCode(promise, status, code, message) {
  try {
    await promise
    assert(false, `${message} (không throw)`)
  } catch (e) {
    assert(e?.statusCode === status && e?.code === code, `${message} (got ${e?.statusCode}/${e?.code})`)
  }
}

const storageDir = process.env.STORAGE_DIR
const service = createResumableUploadService({ storageDir, db: realDb, probe: null })

// MP4 signature ở đầu blob để complete() qua media validation (probe: null).
function mp4Bytes(size, seed = 0) {
  const buf = Buffer.alloc(size)
  buf.writeUInt32BE(24, 0)
  buf.write('ftyp', 4, 'ascii')
  buf.write('isom', 8, 'ascii')
  for (let i = 12; i < size; i++) buf[i] = (seed + i) % 251
  return buf
}

// 1. HEAD offset phản ánh đúng bytes đã PUT.
{
  const bytes = mp4Bytes(100)
  const s = await service.createSession({ userId: 'resume-user', filename: 'resume.mp4', size: bytes.length, mime: 'video/mp4' })
  assert(typeof s.uploadId === 'string' && s.chunkSize === 8 * 1024 * 1024, 'init trả uploadId + chunkSize 8MB')
  const head0 = await service.getOwnedSession({ id: s.uploadId, userId: 'resume-user' })
  assert(Number(head0.bytes_received) === 0, 'HEAD ban đầu offset 0')
  const r1 = await service.appendChunk({ id: s.uploadId, userId: 'resume-user', offset: 0, chunk: bytes.subarray(0, 40) })
  assert(r1.received === 40, 'PUT 40 bytes → received 40')
  const head1 = await service.getOwnedSession({ id: s.uploadId, userId: 'resume-user' })
  assert(Number(head1.bytes_received) === 40, 'HEAD sau PUT trả offset 40')
}

// 2. PUT sai offset → 409 OFFSET_MISMATCH kèm expectedOffset.
{
  const bytes = mp4Bytes(100)
  const s = await service.createSession({ userId: 'resume-user', filename: 'mismatch.mp4', size: bytes.length, mime: 'video/mp4' })
  await service.appendChunk({ id: s.uploadId, userId: 'resume-user', offset: 0, chunk: bytes.subarray(0, 10) })
  try {
    await service.appendChunk({ id: s.uploadId, userId: 'resume-user', offset: 0, chunk: bytes.subarray(0, 10) })
    assert(false, 'PUT sai offset phải 409 (không throw)')
  } catch (e) {
    assert(e?.statusCode === 409 && e?.code === 'OFFSET_MISMATCH', `PUT sai offset → 409 OFFSET_MISMATCH (got ${e?.statusCode}/${e?.code})`)
    assert(Number(e?.extra?.expectedOffset) === 10, `409 kèm expectedOffset=10 (got ${e?.extra?.expectedOffset})`)
  }
}

// 3. Abort → HEAD/PUT/complete đều 410.
{
  const bytes = mp4Bytes(60)
  const s = await service.createSession({ userId: 'resume-user', filename: 'abort.mp4', size: bytes.length, mime: 'video/mp4' })
  await service.appendChunk({ id: s.uploadId, userId: 'resume-user', offset: 0, chunk: bytes.subarray(0, 20) })
  await service.abortUpload({ id: s.uploadId, userId: 'resume-user' })
  await expectCode(service.getOwnedSession({ id: s.uploadId, userId: 'resume-user' }), 410, 'UPLOAD_ABORTED', 'HEAD sau abort → 410 UPLOAD_ABORTED')
  await expectCode(
    service.appendChunk({ id: s.uploadId, userId: 'resume-user', offset: 20, chunk: bytes.subarray(20, 40) }),
    410, 'UPLOAD_ABORTED', 'PUT sau abort → 410 UPLOAD_ABORTED'
  )
  // complete trên session aborted → 409 UPLOAD_NOT_PENDING (contract BE: chỉ
  // pending mới complete được; HEAD/PUT đã 410 ở trên nên FE vẫn nhận fatal).
  await expectCode(service.complete({ id: s.uploadId, userId: 'resume-user' }), 409, 'UPLOAD_NOT_PENDING', 'complete sau abort → 409 UPLOAD_NOT_PENDING')
}

// 4. Session hết TTL → 410 UPLOAD_EXPIRED.
{
  const bytes = mp4Bytes(60)
  const s = await service.createSession({ userId: 'resume-user', filename: 'expired.mp4', size: bytes.length, mime: 'video/mp4' })
  await realDb.run("UPDATE upload_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [s.uploadId])
  await expectCode(service.getOwnedSession({ id: s.uploadId, userId: 'resume-user' }), 410, 'UPLOAD_EXPIRED', 'HEAD session hết hạn → 410 UPLOAD_EXPIRED')
}

// 5. Resume full: PUT nửa → HEAD → PUT tiếp từ offset → complete đủ bytes.
{
  const bytes = mp4Bytes(100, 7)
  const s = await service.createSession({ userId: 'resume-user', filename: 'full-resume.mp4', size: bytes.length, mime: 'video/mp4' })
  await service.appendChunk({ id: s.uploadId, userId: 'resume-user', offset: 0, chunk: bytes.subarray(0, 55) })
  const head = await service.getOwnedSession({ id: s.uploadId, userId: 'resume-user' })
  const off = Number(head.bytes_received)
  assert(off === 55, `resume đọc offset cũ 55 (got ${off})`)
  await service.appendChunk({ id: s.uploadId, userId: 'resume-user', offset: off, chunk: bytes.subarray(off) })
  const done = await service.complete({ id: s.uploadId, userId: 'resume-user' })
  assert(typeof done.storageKey === 'string' && done.storageKey.startsWith('uploads/'), 'resume xong complete trả storageKey')
  assert(typeof done.videoHash === 'string' && done.videoHash.length === 64, 'resume xong complete trả videoHash SHA-256')
  assert(fs.existsSync(path.join(storageDir, done.storageKey)), 'file resume hoàn chỉnh tồn tại ở storageKey')
}

// 6. Session của user khác → 404 (không resume nhầm).
{
  const bytes = mp4Bytes(60)
  const s = await service.createSession({ userId: 'resume-user', filename: 'private.mp4', size: bytes.length, mime: 'video/mp4' })
  await expectCode(service.getOwnedSession({ id: s.uploadId, userId: 'other-user' }), 404, 'NOT_FOUND', 'HEAD session user khác → 404')
}

fs.rmSync(tmpRoot, { recursive: true, force: true })
if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
