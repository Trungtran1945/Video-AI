import api from './client'

export const outputsApi = {
  list: (params) => api.get('/outputs', { params }).then((r) => r.data),
  get: (id) => api.get(`/outputs/${id}`).then((r) => r.data),
  youtube: (id, privacy) => api.post(`/outputs/${id}/youtube`, { privacy }).then((r) => r.data),
  youtubeStatus: (id) => api.get(`/outputs/${id}/youtube`).then((r) => r.data),
}
