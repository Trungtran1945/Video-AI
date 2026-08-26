import api from './client'

const CHUNK_SIZE = 8 * 1024 * 1024 // 8MB
export const MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024 // 2GB

async function sliceAsBlob(file, start, end) {
  return file.slice(start, end)
}

/**
 * Upload resumable kiểu TUS: init → PUT từng chunk (resume bằng HEAD nếu rớt) → complete.
 * Backend chưa có endpoint mới → ném lỗi để caller fallback về multipart cũ.
 */
async function uploadResumable(file, { onProgress, signal } = {}) {
  const initRes = await api
    .post('/uploads/init', { filename: file.name, size: file.size, mime: file.type })
    .then((r) => r.data)
  const uploadId = initRes.uploadId || initRes.upload_id

  let offset = 0
  try {
    const head = await api.head(`/uploads/${uploadId}`)
    const received = parseInt(head.headers['upload-offset'] ?? head.headers['x-upload-offset'], 10)
    if (!Number.isNaN(received)) offset = received
  } catch {
    /* backend chưa hỗ trợ HEAD → upload từ đầu */
  }

  while (offset < file.size) {
    if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError')
    const end = Math.min(offset + CHUNK_SIZE, file.size)
    const blob = await sliceAsBlob(file, offset, end)
    await api.put(`/uploads/${uploadId}/chunk`, blob, {
      params: { offset },
      headers: { 'Content-Type': 'application/octet-stream' },
      signal,
    })
    offset = end
    onProgress?.(Math.round((offset / file.size) * 100))
  }

  const done = await api.post(`/uploads/${uploadId}/complete`).then((r) => r.data)
  return { key: done.storageKey || done.storage_key || done.key, url: done.url, filename: file.name, size: file.size }
}

function uploadMultipart(file, { onProgress, signal } = {}) {
  const fd = new FormData()
  fd.append('file', file)
  return api
    .post('/upload', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      signal,
      onUploadProgress: (e) => {
        if (e.total) onProgress?.(Math.round((e.loaded / e.total) * 100))
      },
    })
    .then((r) => r.data)
}

export const uploadApi = {
  upload: (file, opts = {}) => {
    if (file.size > MAX_UPLOAD_SIZE) {
      return Promise.reject(new Error('File vượt quá giới hạn 2GB'))
    }
    // Ưu tiên resumable; lỗi (404/500 — backend chưa nâng cấp) → multipart cũ
    if (opts.resumable === false) return uploadMultipart(file, opts)
    return uploadResumable(file, opts).catch((err) => {
      if (err?.name === 'AbortError' || err?.code === 'ERR_CANCELED') throw err
      if (file.size > 100 * 1024 * 1024 && opts.requireResumable) {
        throw new Error('File lớn cần upload resumable nhưng backend chưa sẵn sàng')
      }
      return uploadMultipart(file, opts)
    })
  },
}
