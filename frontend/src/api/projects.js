import api from './client'

export const projectsApi = {
  list: (params) => api.get('/projects', { params }).then((r) => r.data),
  get: (id) => api.get(`/projects/${id}`).then((r) => r.data),
  create: (body) => api.post('/projects', body).then((r) => r.data),
  timeline: (id) => api.get(`/projects/${id}/timeline`).then((r) => r.data),
  regenerate: (id) => api.post(`/projects/${id}/regenerate`).then((r) => r.data),
  remove: (id) => api.delete(`/projects/${id}`).then((r) => r.data),
  summaryStart: (id) => api.post(`/projects/${id}/summary/start`).then((r) => r.data),
  translateDubStart: (id) => api.post(`/projects/${id}/translate-dub/start`).then((r) => r.data),
  jobs: (id) => api.get(`/projects/${id}/jobs`).then((r) => r.data),
  retryJob: (id, type) => api.post(`/projects/${id}/jobs/${type}/retry`).then((r) => r.data),
  // TRANSLATE_DUB
  transcript: (id) => api.get(`/projects/${id}/transcript`).then((r) => r.data),
  updateTranscript: (id, segments) => api.put(`/projects/${id}/transcript`, { segments }).then((r) => r.data),
  redub: (id) => api.post(`/projects/${id}/translate-dub/redub`).then((r) => r.data),
  getMaskRegions: (id) => api.get(`/projects/${id}/mask-regions`).then((r) => r.data),
  putMaskRegions: (id, regions) => api.put(`/projects/${id}/mask-regions`, { regions }).then((r) => r.data),
  stylePresets: () =>
    api
      .get('/style-presets')
      .then((r) => r.data)
      .catch(() => null), // graceful fallback → caller dùng STYLE_PRESETS_FALLBACK
}
