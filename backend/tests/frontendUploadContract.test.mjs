let videoFiles = null
let resumableUpload = null
try {
  videoFiles = await import('../../frontend/src/lib/videoFiles.js')
  resumableUpload = await import('../../frontend/src/api/resumableUpload.js')
} catch (_) {}

let failures = 0
function assert(condition, message) {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

assert(Boolean(videoFiles?.validateVideoFileSelection), 'frontend video policy module is available')
assert(Boolean(resumableUpload?.uploadResumableFile), 'frontend resumable protocol module is available')
if (!videoFiles?.validateVideoFileSelection || !resumableUpload?.uploadResumableFile) process.exit(1)

const { validateVideoFileSelection, SUPPORTED_VIDEO_EXTENSIONS } = videoFiles
const { uploadResumableFile, parseUploadOffsetHeader } = resumableUpload
assert(SUPPORTED_VIDEO_EXTENSIONS.join(',') === '.mp4,.mov,.m4v,.mkv,.webm', 'frontend exposes the agreed video allowlist')
for (const file of [
  { name: 'movie.mp4', size: 1024, type: 'video/mp4' },
  { name: 'movie.mov', size: 1024, type: 'video/quicktime' },
  { name: 'movie.m4v', size: 1024, type: 'video/x-m4v' },
  { name: 'movie.mkv', size: 1024, type: 'video/x-matroska' },
  { name: 'movie.webm', size: 1024, type: 'video/webm' },
]) {
  let accepted = false
  try {
    validateVideoFileSelection(file)
    accepted = true
  } catch (_) {}
  assert(accepted, `frontend accepts ${file.name}`)
}
for (const file of [
  { name: 'attack.html', size: 1024, type: 'text/html' },
  { name: 'movie.avi', size: 1024, type: 'video/x-msvideo' },
  { name: 'movie.mp4', size: 3 * 1024 * 1024 * 1024, type: 'video/mp4' },
]) {
  let rejected = false
  try { validateVideoFileSelection(file) } catch (_) { rejected = true }
  assert(rejected, `frontend rejects ${file.name}`)
}

function fakeFile(size) {
  return {
    name: 'movie.mp4',
    size,
    type: 'video/mp4',
    slice(start, end) {
      return { start, end, size: end - start }
    },
  }
}

const offsets = []
const file = fakeFile(25)
const completed = await uploadResumableFile(file, {
  initSession: async () => ({ uploadId: 'upload-1', chunkSize: 8 }),
  getOffset: async () => 0,
  putChunk: async ({ offset, chunk }) => {
    offsets.push(offset)
    return { received: offset + chunk.size }
  },
  completeSession: async () => ({ storageKey: 'uploads/final.mp4', videoHash: 'hash' }),
})
assert(offsets.join(',') === '0,8,16,24', 'frontend uses the server-advertised chunk size')
assert(completed.key === 'uploads/final.mp4', 'frontend normalizes the completed storage key')

const conflictOffsets = []
await uploadResumableFile(fakeFile(20), {
  initSession: async () => ({ uploadId: 'upload-2', chunkSize: 8 }),
  getOffset: async () => ({ initial: true, value: 0 }) && 8,
  putChunk: async ({ offset, chunk }) => {
    conflictOffsets.push(offset)
    if (offset === 0) {
      const error = new Error('offset conflict')
      error.response = { status: 409, data: { expectedOffset: 8, error: { code: 'OFFSET_MISMATCH' } } }
      throw error
    }
    return { received: offset + chunk.size }
  },
  completeSession: async () => ({ storageKey: 'uploads/conflict.mp4' }),
})
assert(conflictOffsets.join(',') === '8,16', 'frontend resynchronizes a 409 offset without duplicating bytes')

const lostResponseOffsets = []
await uploadResumableFile(fakeFile(20), {
  initSession: async () => ({ uploadId: 'upload-3', chunkSize: 8 }),
  getOffset: async (uploadId) => uploadId === 'upload-3' && lostResponseOffsets.length ? 8 : 0,
  putChunk: async ({ offset, chunk }) => {
    lostResponseOffsets.push(offset)
    if (offset === 0) throw new Error('response lost after commit')
    return { received: offset + chunk.size }
  },
  completeSession: async () => ({ storageKey: 'uploads/lost.mp4' }),
})
assert(lostResponseOffsets.join(',') === '0,8,16', 'frontend HEAD-resyncs a lost response without resending committed bytes')

let retries = 0
let bounded = false
try {
  await uploadResumableFile(fakeFile(20), {
    initSession: async () => ({ uploadId: 'upload-4', chunkSize: 8 }),
    getOffset: async () => 0,
    putChunk: async () => {
      retries += 1
      throw new Error('network down')
    },
    completeSession: async () => ({ storageKey: 'uploads/unreachable.mp4' }),
    maxTransientRetries: 2,
  })
} catch (_) {
  bounded = retries === 3
}
assert(bounded, `frontend transient chunk retries are bounded (got ${retries})`)

let offsetCalls = 0
const malformedOffsets = []
await uploadResumableFile(fakeFile(8), {
  initSession: async () => ({ uploadId: 'upload-5', chunkSize: 4 }),
  getOffset: async () => {
    offsetCalls += 1
    return offsetCalls === 1 ? 0 : 4
  },
  putChunk: async ({ offset, chunk }) => {
    malformedOffsets.push(offset)
    return { received: malformedOffsets.length === 1 ? offset : offset + chunk.size }
  },
  completeSession: async () => ({ storageKey: 'uploads/malformed.mp4' }),
})
assert(offsetCalls === 2 && malformedOffsets.join(',') === '0,4', 'frontend HEAD-resyncs a malformed chunk offset response')

let completeAttempts = 0
await uploadResumableFile(fakeFile(8), {
  initSession: async () => ({ uploadId: 'upload-6', chunkSize: 8 }),
  getOffset: async () => 0,
  putChunk: async ({ offset, chunk }) => ({ received: offset + chunk.size }),
  completeSession: async () => {
    completeAttempts += 1
    if (completeAttempts === 1) throw new Error('complete response lost')
    return { storageKey: 'uploads/complete-retry.mp4', videoHash: 'same-hash' }
  },
  maxTransientRetries: 2,
})
assert(completeAttempts === 2, 'frontend retries completion with the same upload id after a lost response')

let invalidCompleteAttempts = 0
let invalidCompletionRejected = false
try {
  await uploadResumableFile(fakeFile(8), {
    initSession: async () => ({ uploadId: 'upload-7', chunkSize: 8 }),
    getOffset: async () => 0,
    putChunk: async ({ offset, chunk }) => ({ received: offset + chunk.size }),
    completeSession: async () => {
      invalidCompleteAttempts += 1
      return invalidCompleteAttempts < 3 ? null : { storageKey: 'uploads/too-late.mp4' }
    },
    maxTransientRetries: 1,
  })
} catch (_) {
  invalidCompletionRejected = true
}
assert(invalidCompletionRejected && invalidCompleteAttempts === 2, 'frontend bounds invalid completion responses')

let missingKeyAttempts = 0
let missingKeyRejected = false
try {
  await uploadResumableFile(fakeFile(8), {
    initSession: async () => ({ uploadId: 'upload-8', chunkSize: 8 }),
    getOffset: async () => 0,
    putChunk: async ({ offset, chunk }) => ({ received: offset + chunk.size }),
    completeSession: async () => {
      missingKeyAttempts += 1
      return missingKeyAttempts < 3 ? { storageKey: null } : { storageKey: 'uploads/too-late.mp4' }
    },
    maxTransientRetries: 1,
  })
} catch (_) {
  missingKeyRejected = true
}
assert(missingKeyRejected && missingKeyAttempts === 2, 'frontend retries completion responses without a valid storage key')
assert(parseUploadOffsetHeader('0') === 0 && parseUploadOffsetHeader('12') === 12, 'decimal upload offset headers are accepted')
for (const malformed of ['', ' ', '4junk', '4.9', '0x10', '04']) {
  assert(parseUploadOffsetHeader(malformed) === null, `malformed upload offset header is rejected: ${JSON.stringify(malformed)}`)
}

if (failures > 0) process.exit(1)
console.log('ALL PASS')
