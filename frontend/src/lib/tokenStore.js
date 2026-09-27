// Access token chỉ sống trong RAM (memory-only): không bao giờ ghi localStorage,
// XSS không đọc được. Reload trang → AuthContext silent-refresh bằng HttpOnly cookie.
let accessToken = null

export function setAccessToken(token) {
  accessToken = token || null
}

export function getAccessToken() {
  return accessToken
}

export function clearAccessToken() {
  accessToken = null
}
