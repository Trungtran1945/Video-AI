// Friendly mapping for backend provider error codes (TransFlow behavior).
// Backend sends `[PROVIDER_QUOTA_EXCEEDED] ...` / `[NO_PROVIDER_AVAILABLE] ...`
// — show root cause, never a raw stage timeout when quota is the cause.
export function friendlyJobError(raw) {
  const msg = String(raw || '')
  if (!msg) return ''
  const isQuota = /PROVIDER_QUOTA_EXCEEDED|NO_PROVIDER_AVAILABLE|hết quota|quota exceeded|quota exhausted/i.test(msg)
  if (isQuota) {
    return 'AI provider đã hết quota. Hệ thống đã thử provider dự phòng nếu có. Vui lòng thử lại sau hoặc cấu hình provider khác.'
  }
  // Legacy timeout masking a quota root cause is no longer emitted, but guard
  // old rows: a bare stage timeout stays as-is (no false quota claim).
  return msg.length > 220 ? `${msg.slice(0, 220)}…` : msg
}

export default { friendlyJobError }
