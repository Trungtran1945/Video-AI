import api from './client'

export const authApi = {
  register: (email, password, name) =>
    api.post('/auth/register', { email, password, name }).then((r) => r.data),
  login: (email, password) =>
    api.post('/auth/login', { email, password }).then((r) => r.data),
  refresh: (refreshToken) =>
    api.post('/auth/refresh', { refreshToken }).then((r) => r.data),
  logout: () => api.post('/auth/logout').then((r) => r.data),
  me: () => api.get('/auth/me').then((r) => r.data),
  forgotPassword: (email) =>
    api.post('/auth/forgot-password', { email }).then((r) => r.data),
  resetPassword: (token, newPassword) =>
    api.post('/auth/reset-password', { token, newPassword }).then((r) => r.data),
}
