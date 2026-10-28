import { canonicalVideoMimeType, validateVideoFileSelection, videoExtension } from '../lib/videoFiles.js'

const MAX_CHUNK_SIZE = 8 * 1024 * 1024

function normalizeOffset(value) {
  const offset = Number(value)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Server trả về offset không hợp lệ')
  return offset
}

function errorCode(error) {
  return error?.response?.data?.error?.code || error?.response?.data?.code || error?.code
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError'
}

function isTransient(error) {
  const status = Number(error?.response?.status || 0)
  return !error?.response || status >= 500
}

export function parseUploadOffsetHeader(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null
  const offset = Number(value)
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null
}

// R1: backoff giữa các lần retry transient (rớt mạng). Tôn trọng AbortSignal.
function delayFor(attemptIndex, retryDelaysMs) {
  const list = Array.isArray(retryDelaysMs) && retryDelaysMs.length ? retryDelaysMs : [1000]
  return list[Math.min(attemptIndex, list.length - 1)]
}

function sleepCancellable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Upload aborted', 'AbortError'))
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Upload aborted', 'AbortError'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

// R1: đợi browser online trở lại trước khi HEAD resync (guard SSR/test).
function waitForOnline(signal) {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) return Promise.resolve()
  if (typeof window === 'undefined') return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Upload aborted', 'AbortError'))
    const onUp = () => {
      window.removeEventListener('online', onUp)
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }
    const onAbort = () => {
      window.removeEventListener('online', onUp)
      reject(new DOMException('Upload aborted', 'AbortError'))
    }
    window.addEventListener('online', onUp, { once: true })
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function statusOf(error) {
  return Number(error?.response?.status || 0)
}

// R1: session chết (aborted/expired/khác user) là fatal — UI hiện "phiên hết hạn",
// không retry vô hạn. Gắn cờ lên error gốc, không đổi shape BE.
function markFatalUpload(error) {
  const status = statusOf(error)
  if ((status === 404 || status === 410) && error && typeof error === 'object') {
    error.fatalUpload = true
  }
  return error
}

// R1: uploadResumableFile(file, {...}) — thêm resume-session + backoff + đợi online.
// Options mới (đều optional, call-site cũ tương thích):
//   initialUploadId?: string — resume session cũ, bỏ qua initSession
//   onUploadId?: (id) => void — gọi ngay khi có uploadId (mới hoặc resume) để caller persist
//   maxTransientRetries = 5 (cũ 2), retryDelaysMs = [1s,2s,5s,10s,15s]
export async function uploadResumableFile(file, {
  initSession,
  getOffset,
  putChunk,
  completeSession,
  onProgress,
  signal,
  maxTransientRetries = 5,
  retryDelaysMs = [1000, 2000, 5000, 10000, 15000],
  initialUploadId = null,
  onUploadId,
} = {}) {
  const media = validateVideoFileSelection(file)
  let uploadId = initialUploadId || null
  let chunkSize = MAX_CHUNK_SIZE
  if (uploadId) {
    // Resume: chunk protocol cố định 8MB phía server; caller chịu trách nhiệm
    // session cùng file (fingerprint name+size+mime).
    onUploadId?.(uploadId)
  } else {
    const initialized = await initSession({
      filename: file.name,
      size: file.size,
      mime: canonicalVideoMimeType(media.extension),
    })
    uploadId = initialized?.uploadId || initialized?.upload_id
    chunkSize = Number(initialized?.chunkSize)
    if (!uploadId || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_CHUNK_SIZE) {
      throw new Error('Máy chủ trả về cấu hình upload không hợp lệ')
    }
    onUploadId?.(uploadId)
  }
  // Offset khởi đầu qua HEAD — transient (rớt mạng lúc resume) cũng retry
  // trong cùng budget, chỉ 404/410 là fatal.
  let offset
  {
    let headAttempts = 0
    for (;;) {
      if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError')
      try {
        offset = normalizeOffset(await getOffset(uploadId, { required: true }))
        break
      } catch (error) {
        if (isAbort(error)) throw error
        markFatalUpload(error)
        if (error.fatalUpload || !isTransient(error) || headAttempts >= maxTransientRetries) throw error
        headAttempts += 1
        await sleepCancellable(delayFor(headAttempts - 1, retryDelaysMs), signal)
        await waitForOnline(signal)
      }
    }
  }
  if (offset > file.size) throw new Error('Server offset vượt quá kích thước tệp')
  let transientRetries = 0
  let offsetResyncs = 0
  onProgress?.(Math.round((offset / file.size) * 100))

  while (offset < file.size) {
    if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError')
    const end = Math.min(offset + chunkSize, file.size)
    const chunk = file.slice(offset, end)
    try {
      const result = await putChunk({ uploadId, offset, chunk })
      const received = normalizeOffset(result?.received ?? end)
      if (received < offset || received > file.size) throw new Error('Server trả về offset không hợp lệ')
      if (received !== end) {
        if (offsetResyncs >= maxTransientRetries) throw new Error('Server offset không tiến triển')
        offsetResyncs += 1
        offset = normalizeOffset(await getOffset(uploadId, { required: true }))
        if (offset > file.size) throw new Error('Server offset vượt quá kích thước tệp')
        onProgress?.(Math.round((offset / file.size) * 100))
        continue
      }
      offset = received
      transientRetries = 0
      offsetResyncs = 0
      onProgress?.(Math.round((offset / file.size) * 100))
    } catch (error) {
      if (isAbort(error)) throw error
      markFatalUpload(error)
      if (error.fatalUpload) throw error
      const status = statusOf(error)
      if (status === 409 && errorCode(error) === 'OFFSET_MISMATCH') {
        const expectedOffset = normalizeOffset(error?.response?.data?.expectedOffset)
        if (expectedOffset <= offset) throw new Error('Server offset không tiến triển')
        offset = expectedOffset
        if (offset > file.size) throw new Error('Server offset vượt quá kích thước tệp')
        transientRetries = 0
        offsetResyncs = 0
        onProgress?.(Math.round((offset / file.size) * 100))
        continue
      }
      if (!isTransient(error) || transientRetries >= maxTransientRetries) throw error
      transientRetries += 1
      await sleepCancellable(delayFor(transientRetries - 1, retryDelaysMs), signal)
      await waitForOnline(signal)
      try {
        offset = normalizeOffset(await getOffset(uploadId, { required: true }))
      } catch (headErr) {
        if (isAbort(headErr)) throw headErr
        markFatalUpload(headErr)
        if (headErr.fatalUpload) throw headErr
        // HEAD transient fail tính vào cùng budget (đã tăng ở trên) — giữ
        // offset local, vòng sau PUT lại sẽ nhận 409 resync từ server.
      }
      if (offset > file.size) throw new Error('Server offset vượt quá kích thước tệp')
    }
  }

  let completed = null
  let completionRetries = 0
  while (true) {
    try {
      const result = await completeSession(uploadId)
      const key = result?.storageKey || result?.storage_key || result?.key
      if (typeof key !== 'string' || !key.trim()) throw new Error('Máy chủ không trả về storage key')
      completed = { ...result, key }
      break
    } catch (error) {
      if (isAbort(error)) throw error
      markFatalUpload(error)
      if (!isTransient(error) || error.fatalUpload || completionRetries >= maxTransientRetries) throw error
      completionRetries += 1
      // HEAD resync best-effort trước retry (tránh complete khi server thiếu bytes → 409 INCOMPLETE).
      try { await getOffset(uploadId, {}) } catch { /* bỏ qua, retry bên dưới quyết định */ }
      await sleepCancellable(delayFor(completionRetries - 1, retryDelaysMs), signal)
      await waitForOnline(signal)
    }
  }
  return {
    key: completed.key,
    url: completed?.url,
    filename: file.name,
    size: file.size,
    videoHash: completed?.videoHash || completed?.video_hash || null,
    mime: canonicalVideoMimeType(videoExtension(file.name)),
  }
}
