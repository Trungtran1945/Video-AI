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

export async function uploadResumableFile(file, {
  initSession,
  getOffset,
  putChunk,
  completeSession,
  onProgress,
  signal,
  maxTransientRetries = 2,
} = {}) {
  const media = validateVideoFileSelection(file)
  const initialized = await initSession({
    filename: file.name,
    size: file.size,
    mime: canonicalVideoMimeType(media.extension),
  })
  const uploadId = initialized?.uploadId || initialized?.upload_id
  const chunkSize = Number(initialized?.chunkSize)
  if (!uploadId || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_CHUNK_SIZE) {
    throw new Error('Máy chủ trả về cấu hình upload không hợp lệ')
  }
  let offset = normalizeOffset(await getOffset(uploadId, { required: true }))
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
      const status = Number(error?.response?.status || 0)
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
      offset = normalizeOffset(await getOffset(uploadId, { required: true }))
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
      if (isAbort(error) || !isTransient(error) || completionRetries >= maxTransientRetries) throw error
      completionRetries += 1
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
