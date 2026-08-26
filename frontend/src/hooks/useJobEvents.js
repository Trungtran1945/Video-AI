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

    const applyEvent = (raw) => {
      try {
        const data = JSON.parse(raw)
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
