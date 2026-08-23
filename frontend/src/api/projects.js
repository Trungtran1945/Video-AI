import api from './client'

export const projectsApi = {
  list: (params) => api.get('/projects', { params }).then((r) => r.data),
  get: (id) => api.get(`/projects/${id}`).then((r) => r.data),
  create: (body) => api.post('/projects', body).then((r) => r.data),
  timeline: (id) => api.get(`/projects/${id}/timeline`).then((r) => r.data),
  regenerate: (id) => api.post(`/projects/${id}/regenerate`).then((r) => r.data),
  remove: (id) => api.delete(`/projects/${id}`).then((r) => r.data),
  summaryStart: (id) => api.post(`/projects/${id}/summary/start`).then((r) => r.data),
  styleStart: (id) => api.post(`/projects/${id}/style-edit/start`).then((r) => r.data),
  jobs: (id) => api.get(`/projects/${id}/jobs`).then((r) => r.data),
  retryJob: (id, type) => api.post(`/projects/${id}/jobs/${type}/retry`).then((r) => r.data),
}
