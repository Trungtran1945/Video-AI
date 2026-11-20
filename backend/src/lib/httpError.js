import crypto from 'node:crypto'
import { sanitizeErrorMessage } from './xssSanitizer.js'
import { sanitizeResponseDto, sanitizeStringContent } from './responseSanitizer.js'

// Chuẩn lỗi theo docs/06 §0 + §8: body lỗi luôn kèm `error: { code, message }`.
// Top-level `message`/`code` được giữ song song để tương thích frontend hiện tại
// (các trang đọc err.response.data.message).
export const ERR = {
  AUTH_TOKEN: 'AUTH_001',        // thiếu / hết hạn token
  AUTH_FORBIDDEN: 'AUTH_002',    // không đủ quyền
  VALIDATION: 'VAL_001',         // validate thất bại (kèm field khi có)
  OVERLAP_CONFLICT: 'VAL_002',   // overlap timing không tự giải quyết được
  CONCURRENCY_LIMIT: 'LIMIT_001', // đạt giới hạn concurrency
  COPYRIGHT_MISSING: 'COPYRIGHT_001', // thiếu xác nhận bản quyền
  PROJECT_NOT_FOUND: 'PROJ_001', // project không tồn tại
  REVISION_CONFLICT: 'CONFLICT_001', // optimistic concurrency: revision đã cũ
  PROVIDER: 'PROV_001',          // provider lỗi (xem ProviderLog)
  JOB_NOT_RETRYABLE: 'JOB_001',  // job thất bại không thể retry
}

export function sendError(res, status, code, message, extra = {}) {
  if (status === 429 && extra?.retryAfterSec !== undefined && !res.headersSent) {
    try {
      res.setHeader('Retry-After', String(extra.retryAfterSec))
    } catch (_) {}
  }

  const isServerFault = typeof status === 'number' && status >= 500
  let cleanMessage = sanitizeErrorMessage(message)

  // SEC-10: In production, mask detailed 500 server errors from client
  if (isServerFault && process.env.NODE_ENV === 'production') {
    cleanMessage = 'Internal server error'
  } else if (cleanMessage) {
    cleanMessage = sanitizeStringContent(cleanMessage)
  }

  // Sanitize any extra payload to avoid leaking sensitive fields
  const safeExtra = sanitizeResponseDto(extra || {})

  const payload = {
    message: cleanMessage,
    code,
    ...safeExtra,
    error: {
      code,
      message: cleanMessage,
    },
  }

  // Attach traceable errorId for 5xx server errors
  if (isServerFault) {
    const errorId = crypto.randomUUID()
    payload.errorId = errorId
    payload.error.errorId = errorId
  }

  return res.status(status).json(payload)
}

export default { ERR, sendError }
