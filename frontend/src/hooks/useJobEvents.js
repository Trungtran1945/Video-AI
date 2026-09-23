import { useEffect, useRef, useState } from 'react'
import { apiClient } from '@/api/client'

const API_BASE = import.meta.env.VITE_API_BASE || '/api/v1'

/**
 * Lắng nghe tiến trình pipeline realtime qua SSE GET /projects/:id/events.
 * Auth: fetch POST /sse-ticket (Bearer) rồi mở EventSource với ?ticket=
 * (single-use, TTL 60s) — KHÔNG để JWT dài hạn trong URL.
 * Ticket fetch lỗi → sseAvailable=false để caller fallback polling (DB truth).
 * Trả về: { events, lastEvent, sseAvailable, streamClosed }
 *  - events: map stage → { status, percent }
 *  - done chỉ nghĩa stream closed — KHÔNG tự suy diễn completed, caller phải
 *    fetch project status (DB authoritative).
 */
export function useJobEvents(projectId, enabled = true) {
  const [events, setEvents] = useState({})
  const [lastEvent, setLastEvent] = useState(null)
  const [sseAvailable, setSseAvailable] = useState(true)
  const [streamClosed, setStreamClosed] = useState(false)
  const sourceRef = useRef(null)

  useEffect(() => {
    if (!projectId || !enabled) return undefined
    let cancelled = false
    setStreamClosed(false)

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

    const openWithTicket = async () => {
      let url = null
      try {
        const { data } = await apiClient.post(`/projects/${projectId}/sse-ticket`)
        if (cancelled) return
        if (data?.ticket) {
          url = `${API_BASE}/projects/${projectId}/events?ticket=${encodeURIComponent(data.ticket)}`
        }
      } catch {
        /* ticket không lấy được → fallback polling, không để JWT vào URL */
      }
      if (cancelled) return
      if (!url) {
        setSseAvailable(false)
        return
      }
      const es = new EventSource(url)
      sourceRef.current = es
      es.onmessage = (e) => applyEvent(e.data)
      es.addEventListener('progress', (e) => applyEvent(e.data))
      // done = stream closed (backend đã gửi terminal progress trước đó nếu có).
      // Không tự tạo completed — caller fetch DB để lấy truth.
      es.addEventListener('done', () => {
        setStreamClosed(true)
        try { es.close() } catch { /* noop */ }
        sourceRef.current = null
      })
      es.onerror = () => {
        setSseAvailable(false)
        try { es.close() } catch { /* noop */ }
        sourceRef.current = null
      }
    }

    openWithTicket()

    return () => {
      cancelled = true
      try { sourceRef.current?.close() } catch { /* noop */ }
      sourceRef.current = null
    }
  }, [projectId, enabled])

  return { events, lastEvent, sseAvailable, streamClosed }
}
