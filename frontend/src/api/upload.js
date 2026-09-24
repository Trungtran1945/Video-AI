import api from './client'
import { parseUploadOffsetHeader, uploadResumableFile } from './resumableUpload'
import { validateVideoFileSelection } from '../lib/videoFiles'

export { MAX_UPLOAD_SIZE } from '../lib/videoFiles'

const UPLOAD_REQUEST_TIMEOUT_MS = 2 * 60 * 60 * 1000

function uploadMultipart(file, { onProgress, signal } = {}) {
  const form = new FormData()
  form.append('file', file)
  return api.post('/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      signal,
      timeout: UPLOAD_REQUEST_TIMEOUT_MS,

    onUploadProgress: (event) => {
      if (event.total) onProgress?.(Math.round((event.loaded / event.total) * 100))
    },
  }).then((response) => response.data)
}

function uploadResumable(file, options = {}) {
  return uploadResumableFile(file, {
    ...options,
    initSession: (metadata) => api.post('/uploads/init', metadata, { signal: options.signal, timeout: UPLOAD_REQUEST_TIMEOUT_MS }).then((response) => response.data),
    getOffset: async (uploadId, { required } = {}) => {
      const response = await api.head(`/uploads/${uploadId}`, { signal: options.signal, timeout: UPLOAD_REQUEST_TIMEOUT_MS })
      const offset = parseUploadOffsetHeader(response.headers['upload-offset'] ?? response.headers['x-upload-offset'])
      if (offset === null && required) throw new Error('Server không trả về upload offset')
      return offset ?? 0
    },
    putChunk: async ({ uploadId, offset, chunk }) => {
      const response = await api.put(`/uploads/${uploadId}/chunk`, chunk, {
        params: { offset },
        headers: { 'Content-Type': 'application/octet-stream' },
        signal: options.signal,
        timeout: UPLOAD_REQUEST_TIMEOUT_MS,
      })
      return { received: parseUploadOffsetHeader(response.headers['upload-offset']) ?? offset + chunk.size }
    },
    completeSession: (uploadId) => api.post(`/uploads/${uploadId}/complete`, null, { signal: options.signal, timeout: UPLOAD_REQUEST_TIMEOUT_MS }).then((response) => response.data),
  })
}

export const uploadApi = {
  upload(file, options = {}) {
    try {
      validateVideoFileSelection(file)
    } catch (error) {
      return Promise.reject(error)
    }
    if (options.resumable === false) return uploadMultipart(file, options)
    return uploadResumable(file, options)
  },
}
