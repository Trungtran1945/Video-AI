import api from './client'

export const uploadApi = {
  upload: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return api
      .post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then((r) => r.data)
  },
}
