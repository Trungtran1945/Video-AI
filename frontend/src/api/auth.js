import api, { refreshSession } from './client'

export const authApi = {
  register: (email, password, name) =>
    api.post('/auth/register', { email, password, name }).then((r) => r.data),
  registerSendOtp: (email, password, name) =>
    api.post('/auth/register/send-otp', { email, password, name }).then((r) => r.data),
  registerVerifyOtp: (email, otp, password, name) =>
    api.post('/auth/register/verify-otp', { email, otp, password, name }).then((r) => r.data),
  googleLogin: (credential) =>
    api.post('/auth/google', typeof credential === 'object' ? credential : { credential }).then((r) => r.data),
  login: (email, password) =>
    api.post('/auth/login', { email, password }).then((r) => r.data),
  refresh: () => refreshSession(),
  logout: () => api.post('/auth/logout').then((r) => r.data),
  me: () => api.get('/auth/me').then((r) => r.data),
  forgotPassword: (email) =>
    api.post('/auth/forgot-password', { email }).then((r) => r.data),
  resetPassword: (token, newPassword) =>
    api.post('/auth/reset-password', { token, newPassword }).then((r) => r.data),
  sendOtp: (email) =>
    api.post('/auth/otp/send', { email }).then((r) => r.data),
  loginWithOtp: (email, otp) =>
    api.post('/auth/otp/verify', { email, otp }).then((r) => r.data),
}
