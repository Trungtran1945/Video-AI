// Friendly mapping for backend provider error codes (TransFlow behavior).
// Backend sends `[PROVIDER_QUOTA_EXCEEDED] ...` / `[NO_PROVIDER_AVAILABLE] ...`
// or ZeroTTS admission/limit errors — show root cause, never a raw stage timeout.
export function friendlyJobError(raw) {
  let msg = ''
  let aggregate = null

  if (typeof raw === 'object' && raw !== null) {
    aggregate = raw.aggregate || raw.details?.aggregate || null
    msg = String(raw.message || raw.error_message || raw.error || raw.code || '')
  } else {
    msg = String(raw || '')
  }

  if (!msg) return ''

  // 1. ZeroTTS backpressure & admission queue limits (429 / 503 SERVER_BUSY / QUEUE_FULL)
  if (
    /SERVER_BUSY|QUEUE_FULL|admission queue full|concurrency limit reached|Server is stopping/i.test(msg) ||
    (/TTS/i.test(msg) && /(429|503)/.test(msg))
  ) {
    return 'Máy chủ TTS đang bận, thử lại sau'
  }

  // 2. Request body / text length limits (413 BODY_TOO_LARGE / TEXT_TOO_LONG)
  if (/413|BODY_TOO_LARGE|TEXT_TOO_LONG|body too large|text too long/i.test(msg)) {
    return 'Văn bản quá dài'
  }

  // 3. Voice not found / invalid text — keep meaningful server message as-is
  if (/Voice '.*' không tồn tại/i.test(msg)) {
    return msg
  }
  if (/VOICE_NOT_FOUND/i.test(msg)) {
    return 'Giọng đọc không tồn tại hoặc không được hỗ trợ.'
  }
  if (/Text is required and must not be empty|TTS text rỗng/i.test(msg)) {
    return 'Văn bản yêu cầu không được để trống.'
  }
  if (/INVALID_TEXT/i.test(msg)) {
    return 'Văn bản không hợp lệ.'
  }

  // 4. Failover aggregate classifications (BE-F02: root-cause classification instead of raw timeout)
  if (
    aggregate === 'ALL_TRANSIENT' ||
    (msg.includes('NO_PROVIDER_AVAILABLE') && /ALL_TRANSIENT|PROVIDER_RATE_LIMITED|PROVIDER_TIMEOUT|PROVIDER_NETWORK_ERROR/i.test(msg))
  ) {
    return 'Các nhà cung cấp AI đang bận hoặc gặp lỗi tạm thời. Vui lòng thử lại sau.'
  }
  if (
    aggregate === 'ALL_AUTH' ||
    (msg.includes('NO_PROVIDER_AVAILABLE') && /ALL_AUTH|PROVIDER_AUTH_FAILED/i.test(msg))
  ) {
    return 'Xác thực API thất bại trên các nhà cung cấp AI. Vui lòng kiểm tra lại API Key trong cài đặt.'
  }
  if (
    aggregate === 'ALL_PERMISSION' ||
    (msg.includes('NO_PROVIDER_AVAILABLE') && /ALL_PERMISSION|PROVIDER_PERMISSION_DENIED/i.test(msg))
  ) {
    return 'Không có quyền truy cập mô hình AI trên các nhà cung cấp. Vui lòng kiểm tra lại quyền tài khoản API.'
  }
  if (
    aggregate === 'ALL_CONFIGURATION' ||
    (msg.includes('NO_PROVIDER_AVAILABLE') && /ALL_CONFIGURATION|PROVIDER_MODEL_NOT_FOUND|PROVIDER_INVALID_REQUEST/i.test(msg))
  ) {
    return 'Cấu hình yêu cầu AI không hợp lệ hoặc mô hình không tồn tại.'
  }

  // 5. Quota exceeded (single provider or ALL_QUOTA)
  const isQuota =
    aggregate === 'ALL_QUOTA' ||
    /PROVIDER_QUOTA_EXCEEDED|ALL_QUOTA|hết quota|quota exceeded|quota exhausted/i.test(msg)
  if (isQuota) {
    return 'AI provider đã hết quota. Hệ thống đã thử provider dự phòng nếu có. Vui lòng thử lại sau hoặc cấu hình provider khác.'
  }

  // 6. Generic failover exhaustion
  if (/NO_PROVIDER_AVAILABLE/i.test(msg)) {
    return 'Tất cả nhà cung cấp AI đều không khả dụng. Vui lòng thử lại sau hoặc cấu hình provider khác.'
  }

  // Legacy timeout masking a quota root cause is no longer emitted, but guard
  // old rows: a bare stage timeout stays as-is (no false quota claim).
  return msg.length > 220 ? `${msg.slice(0, 220)}…` : msg
}

export default { friendlyJobError }

