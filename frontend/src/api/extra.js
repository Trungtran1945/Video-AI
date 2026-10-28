import api from './client'
import { resolveSystemPath } from '../lib/apiBase'

export const queueApi = {
  list: () => api.get('/queue').then((r) => r.data),
}

export const logsApi = {
  list: (limit) => api.get('/logs', { params: { limit } }).then((r) => r.data),
}

export const analyticsApi = {
  get: () => api.get('/analytics').then((r) => r.data),
}

export const providersApi = {
  list: () => api.get('/providers').then((r) => r.data),
  // 1-request aggregate thay cho fan-out N quota() (docs/06 §5).
  // Backend trả { providers: {name: snapshot} } — QuotaBanner chuẩn hoá cả 2 dạng.
  quotaSummary: () => api.get('/providers/quota-summary').then((r) => r.data),
  // Backend không có GET /providers/zerotts/health — dùng providersApi.list()
  // (tts[].id === 'zerotts' + health) hoặc quota-summary thay thế.
}

export const settingsApi = {
  get: () => api.get('/settings').then((r) => r.data),
  update: (patch) => api.put('/settings', patch).then((r) => r.data),
}

export const apiKeysApi = {
  list: () => api.get('/api-keys').then((r) => r.data),
  create: (provider, label, key, { tier, priority } = {}) =>
    api.post('/api-keys', { provider, label, key, tier, priority }).then((r) => r.data),
  remove: (id) => api.delete(`/api-keys/${id}`).then((r) => r.data),
  toggle: (id, isActive) => api.put(`/api-keys/${id}`, { isActive }).then((r) => r.data),
  update: (id, patch) => api.put(`/api-keys/${id}`, patch).then((r) => r.data),
  quota: (provider) => api.get(`/providers/${provider}/quota`).then((r) => r.data),
}

export const adminApi = {
  users: () => api.get('/admin/users').then((r) => r.data),
  setRole: (id, role) => api.put(`/admin/users/${id}`, { role }).then((r) => r.data),
  // D2 (YAGNI — gỡ dead client): providers() 0 call-site (Admin không dùng).
  // BE giữ route admin.js:52 cho backward-compat.
  cleanupTasks: (params) => api.get('/admin/cleanup-tasks', { params }).then((r) => r.data),
  retryCleanupTask: (id) => api.post(`/admin/cleanup-tasks/${id}/retry`).then((r) => r.data),
  // R3 Chu kỳ 2: depth BullMQ + tồn đọng DB (degraded khi Redis down → null).
  queueMetrics: () => api.get('/admin/queue-metrics').then((r) => r.data).catch(() => null),
}

export const systemApi = {
  // Giữ api instance (JWT + refresh interceptor), chỉ đổi URL: dev relative
  // (Vite proxy), prod absolute cùng origin API (strip /api/v1).
  health: () => api.get(resolveSystemPath('/health'), { baseURL: '' }).then((r) => r.data),
  // D2 (YAGNI — gỡ dead client): ready() 0 call-site; Admin đã hiển thị
  // database.persistenceState (HEALTHY/DEGRADED/WRITE_BLOCKED) từ /health —
  // fetch thêm /ready trùng thông tin. BE giữ GET /ready (server.js:114).
}

export const youtubeApi = {
  getAccount: () => api.get('/youtube/account').then((r) => r.data),
  startOAuth: () => api.post('/youtube/oauth/start').then((r) => r.data),
  disconnectAccount: () => api.delete('/youtube/account').then((r) => r.data),
  publishOutput: (outputId, payload) => api.post(`/outputs/${outputId}/youtube`, payload).then((r) => r.data),
  getPublishStatus: (outputId) => api.get(`/outputs/${outputId}/youtube`).then((r) => r.data),
  cancelPublish: (outputId) => api.post(`/outputs/${outputId}/youtube/cancel`).then((r) => r.data),
}
