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
  // Group 1: Cancel pipeline
  cancel: (id) => api.post(`/projects/${id}/cancel`).then((r) => r.data),
  transcript: (id) => api.get(`/projects/${id}/transcript`).then((r) => r.data),
  updateTranscript: (id, segments, revision) =>
    api.put(`/projects/${id}/transcript`, { segments, revision }).then((r) => r.data),
  updateSegmentTranslation: (id, segmentId, translation, revision) =>
    api.patch(`/projects/${id}/segments/${segmentId}/translation`, { translation, revision }).then((r) => r.data),
  redub: (id) => api.post(`/projects/${id}/translate-dub/redub`).then((r) => r.data),
  // Manual/auto subtitle masks (che/làm mờ hardsub gốc)
  masks: (id) => api.get(`/projects/${id}/masks`).then((r) => r.data),
  createMask: (id, body) => api.post(`/projects/${id}/masks`, body).then((r) => r.data),
  updateMask: (id, maskId, body) => api.patch(`/projects/${id}/masks/${maskId}`, body).then((r) => r.data),
  deleteMask: (id, maskId) => api.delete(`/projects/${id}/masks/${maskId}`).then((r) => r.data),
  // Group 1: Confirm preview (FR-J2)
  confirmPreview: (id) => api.post(`/projects/${id}/translate-dub/confirm-preview`).then((r) => r.data),
  // SSE ticket single-use TTL 60s (không để JWT dài hạn trong URL)
  sseTicket: (id) => api.post(`/projects/${id}/sse-ticket`).then((r) => r.data),
  stylePresets: () =>
    api
      .get('/style-presets')
      .then((r) => r.data)
      .catch(() => null), // graceful fallback → caller dùng STYLE_PRESETS_FALLBACK
}
