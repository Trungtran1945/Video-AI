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
  // User abort → DELETE session best-effort (server 204; sau đó HEAD/PUT/complete → 410).
  // R1: giữ uploadId của cả session resume (initialUploadId) để abort vẫn dọn được.
  let uploadIdRef = options.initialUploadId || null;
  const callerOnUploadId = options.onUploadId;
  if (options.signal) {
    options.signal.addEventListener('abort', () => {
      if (uploadIdRef) api.delete(`/uploads/${uploadIdRef}`).catch(() => {});
    }, { once: true });
  }
  return uploadResumableFile(file, {
    ...options,
    onUploadId: (id) => {
      uploadIdRef = id || uploadIdRef;
      callerOnUploadId?.(id);
    },
    initSession: async (metadata) => {
      const data = await api.post('/uploads/init', metadata, { signal: options.signal, timeout: UPLOAD_REQUEST_TIMEOUT_MS }).then((response) => response.data);
      uploadIdRef = data?.uploadId || data?.upload_id || null;
      return data;
    },
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
    completeSession: (uploadId) => api.post(`/uploads/${uploadId}/complete`, {}, { signal: options.signal, timeout: UPLOAD_REQUEST_TIMEOUT_MS }).then((response) => response.data),
  })
}

// F13 contract multipart-vs-resumable (BE upload.js):
// - Multipart POST /upload (resumable===false): limit 50MB, trả {key,url,filename,size,mimetype} — KHÔNG có videoHash.
// - Resumable POST /uploads/init → PUT chunk (8MB) → POST complete: limit 2GB, trả {key,url,filename,size,videoHash,mime}.
// File >50MB với resumable===false → 413 hướng sang resumable. Path chính luôn là resumable.
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
