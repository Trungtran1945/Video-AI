// Chuẩn lỗi theo docs/06 §0 + §8: body lỗi luôn kèm `error: { code, message }`.
// Top-level `message`/`code` được giữ song song để tương thích frontend hiện tại
// (các trang đọc err.response.data.message).
export const ERR = {
  AUTH_TOKEN: 'AUTH_001',        // thiếu / hết hạn token
  AUTH_FORBIDDEN: 'AUTH_002',    // không đủ quyền
  VALIDATION: 'VAL_001',         // validate thất bại (kèm field khi có)
  PROJECT_NOT_FOUND: 'PROJ_001', // project không tồn tại
  PROVIDER: 'PROV_001',          // provider lỗi (xem ProviderLog)
  JOB_NOT_RETRYABLE: 'JOB_001',  // job thất bại không thể retry
}

export function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json({
    message,
    code,
    ...extra,
    error: { code, message },
  })
}

export default { ERR, sendError }
