import api from './client'

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
}

export const settingsApi = {
  get: () => api.get('/settings').then((r) => r.data),
  update: (patch) => api.put('/settings', patch).then((r) => r.data),
}

export const apiKeysApi = {
  list: () => api.get('/api-keys').then((r) => r.data),
  create: (provider, label, key) =>
    api.post('/api-keys', { provider, label, key }).then((r) => r.data),
  remove: (id) => api.delete(`/api-keys/${id}`).then((r) => r.data),
  toggle: (id, isActive) => api.put(`/api-keys/${id}`, { isActive }).then((r) => r.data),
}

export const adminApi = {
  users: () => api.get('/admin/users').then((r) => r.data),
  setRole: (id, role) => api.put(`/admin/users/${id}`, { role }).then((r) => r.data),
}
