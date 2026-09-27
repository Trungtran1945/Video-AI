import axios from 'axios'
import { getAccessToken, setAccessToken, clearAccessToken } from '../lib/tokenStore'
import { postAccessUpdated } from '../lib/authChannel'
import { createSingleFlight } from './refreshFlight'

const BASE = import.meta.env.VITE_API_BASE || '/api/v1'

export const apiClient = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true, // gửi/nhận HttpOnly refresh cookie (cross-origin deploy)
})

apiClient.interceptors.request.use((config) => {
  const token = getAccessToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

const refreshOnce = createSingleFlight()

// Refresh bằng cookie HttpOnly (không còn body refreshToken). Single-flight:
// nhiều 401 đồng thời → 1 POST /auth/refresh. Trả về { accessToken, user }.
export function refreshSession() {
  return refreshOnce(async () => {
    const { data } = await axios.post(`${BASE}/auth/refresh`, null, { withCredentials: true })
    setAccessToken(data.accessToken)
    postAccessUpdated(data.accessToken, data.user)
    return data
  })
}

apiClient.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true
      const hadSession = Boolean(getAccessToken())
      // Khách vãng lai (không token, không refresh đang chạy) → reject như cũ,
      // không gọi refresh vô ích.
      if (hadSession || refreshOnce.pending()) {
        try {
          const data = await refreshSession()
          original.headers.Authorization = `Bearer ${data.accessToken}`
          return apiClient(original) // retry đúng 1 lần (đã _retry) — không loop
        } catch (e) {
          clearAccessToken()
          if (hadSession) window.location.href = '/login'
          return Promise.reject(error)
        }
      }
    }
    return Promise.reject(error)
  }
)

export default apiClient
