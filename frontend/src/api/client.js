import axios from 'axios'

const BASE = import.meta.env.VITE_API_BASE || '/api/v1'

export const apiClient = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json' },
})

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Auto refresh on 401
apiClient.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true
      const refreshToken = localStorage.getItem('refresh_token')
      if (refreshToken) {
        try {
          const { data } = await axios.post(`${BASE}/auth/refresh`, { refreshToken })
          localStorage.setItem('access_token', data.accessToken)
          localStorage.setItem('refresh_token', data.refreshToken)
          original.headers.Authorization = `Bearer ${data.accessToken}`
          return apiClient(original)
        } catch (e) {
          localStorage.removeItem('access_token')
          localStorage.removeItem('refresh_token')
          window.location.href = '/login'
          return Promise.reject(error)
        }
      }
    }
    return Promise.reject(error)
  }
)

export default apiClient
