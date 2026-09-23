import { useEffect, useRef, useState } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE || '/api/v1'

function getAccessToken() {
  try {
    return localStorage.getItem('access_token') || ''
  } catch {
    return ''
  }
}

/**
 * Lắng nghe tiến trình pipeline realtime qua SSE GET /projects/:id/events.
 * Backend chưa hỗ trợ → onError đặt sseAvailable=false để caller fallback polling.
 * Trả về: { events, lastEvent, sseAvailable }
 *  - events: map stage → { status, percent }
 */
export function useJobEvents(projectId, enabled = true) {
  const [events, setEvents] = useState({})
  const [lastEvent, setLastEvent] = useState(null)
  const [sseAvailable, setSseAvailable] = useState(true)
  const sourceRef = useRef(null)

  useEffect(() => {
    if (!projectId || !enabled) return undefined
    const es = new EventSource(`${API_BASE}/projects/${projectId}/events?token=${encodeURIComponent(getAccessToken())}`)
    sourceRef.current = es

    // Chuẩn hoá vocabulary: backend cũ emit 'success' cho __project__,
    // backend mới emit 'completed' (khớp projects.status). Frontend chỉ dùng 'completed'.
    const normalize = (data) => {
      if (!data || typeof data !== 'object') return data
      if (data.stage === '__project__' && data.status === 'success') {
        return { ...data, status: 'completed' }
      }
      return data
    }

    const applyEvent = (raw) => {
      try {
        const data = normalize(JSON.parse(raw))
        setLastEvent(data)
        setEvents((prev) => ({
          ...prev,
          [data.stage]: {
            status: data.status,
            percent: typeof data.percent === 'number' ? data.percent : prev[data.stage]?.percent,
          },
        }))
      } catch {
        /* bỏ qua event không parse được */
      }
    }

    es.onmessage = (e) => applyEvent(e.data)
    es.addEventListener('progress', (e) => applyEvent(e.data))
    // Backend đóng stream bằng event 'done' sau terminal — coi như completion.
    es.addEventListener('done', () => {
      setLastEvent((prev) => {
        if (prev && prev.stage === '__project__' && ['completed', 'failed'].includes(prev.status)) return prev
        return { stage: '__project__', status: 'completed' }
      })
    })
    es.onerror = () => {
      // SSE chưa có ở backend (404) hoặc mất kết nối → tắt hẳn, fallback polling
      setSseAvailable(false)
      es.close()
      sourceRef.current = null
    }

    return () => {
      es.close()
      sourceRef.current = null
    }
  }, [projectId, enabled])

  return { events, lastEvent, sseAvailable }
}
