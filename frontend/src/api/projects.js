import api from './client'

export const projectsApi = {
  list: (params) => api.get('/projects', { params }).then((r) => r.data),
  get: (id) => api.get(`/projects/${id}`).then((r) => r.data),
  create: (body) => api.post('/projects', body).then((r) => r.data),
  // GET /projects/:id đã kèm timeline — endpoint timeline rời không có call-site → gỡ.
  regenerate: (id, fromStage) =>
    api.post(`/projects/${id}/regenerate`, fromStage ? { fromStage } : {}).then((r) => r.data),
  remove: (id) => api.delete(`/projects/${id}`).then((r) => r.data),
  // Pipeline tự chạy sau POST /projects; chạy lại dùng regenerate()/retryJob()/redub().
  // Hai endpoint start thủ công của backend không có nút UI nào gọi → gỡ khỏi client.
  // D1 (YAGNI — gỡ dead client): GET jobs 0 call-site (detail dùng p.jobs inline từ
  // GET /projects/:id). BE giữ route generation.js:74 cho backward-compat.
  retryJob: (id, type) => api.post(`/projects/${id}/jobs/${type}/retry`).then((r) => r.data),
  // Group 1: Cancel pipeline
  cancel: (id) => api.post(`/projects/${id}/cancel`).then((r) => r.data),
  transcript: (id) => api.get(`/projects/${id}/transcript`).then((r) => r.data),
  updateTranscript: (id, segments, revision) =>
    api.put(`/projects/${id}/transcript`, { segments, revision }).then((r) => r.data),
  // F1 (YAGNI — gỡ dead client): sửa translation từng câu đã làm qua TranscriptEditor
  // bulk PUT transcript (SegmentCard textarea → Lưu). BE giữ route
  // PATCH /projects/:id/segments/:segmentId/translation + contract test, FE không wire riêng.
  redub: (id) => api.post(`/projects/${id}/translate-dub/redub`).then((r) => r.data),
  // Manual/auto subtitle masks (che/làm mờ hardsub gốc)
  masks: (id) => api.get(`/projects/${id}/masks`).then((r) => r.data),
  createMask: (id, body) => api.post(`/projects/${id}/masks`, body).then((r) => r.data),
  updateMask: (id, maskId, body) => api.patch(`/projects/${id}/masks/${maskId}`, body).then((r) => r.data),
  deleteMask: (id, maskId) => api.delete(`/projects/${id}/masks/${maskId}`).then((r) => r.data),
  // Per-project glossary (phase 1: API only, chưa có UI quản lý)
  glossary: (id) => api.get(`/projects/${id}/glossary`).then((r) => r.data),
  addGlossaryTerm: (id, body) => api.post(`/projects/${id}/glossary`, body).then((r) => r.data),
  deleteGlossaryTerm: (id, termId) => api.delete(`/projects/${id}/glossary/${termId}`).then((r) => r.data),
  // SCRIPT_TO_VIDEO APIs
  uploadScript: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return api.post('/script-uploads', fd).then((r) => r.data)
  },
  updateScriptSegment: (id, segmentId, body) =>
    api.patch(`/projects/${id}/script/segments/${segmentId}`, body).then((r) => r.data),
  generateScriptVideo: (id) =>
    api.post(`/projects/${id}/script/generate`).then((r) => r.data),
  getScriptSegmentImageUrl: (id, segmentId, size = 'preview') =>
    `/api/v1/projects/${id}/script/segments/${segmentId}/image?size=${size}`,
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
