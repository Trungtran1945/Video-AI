import { useEffect, useRef, useState } from 'react'
import { apiClient } from '@/api/client'

const API_BASE = import.meta.env.VITE_API_BASE || '/api/v1'

/**
 * Lắng nghe tiến trình pipeline realtime qua SSE GET /projects/:id/events.
 * Auth: fetch POST /sse-ticket (Bearer) rồi mở EventSource với ?ticket=
 * (single-use, TTL 60s) — KHÔNG để JWT dài hạn trong URL.
 * Ticket single-use nên mỗi retry phải xin ticket MỚI (không reuse).
 * Retry giới hạn với backoff [1s, 2s, 5s] rồi fallback polling (DB truth).
 * Không để polling và SSE tạo request storm: chỉ 1 EventSource tại 1 thời điểm.
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
  const timersRef = useRef([])

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

    const SSE_RETRY_BACKOFF_MS = [1000, 2000, 5000]

    const openWithTicket = async (attempt = 0) => {
      if (cancelled) return
      let url = null
      try {
        // Mỗi attempt xin ticket mới (single-use, không reuse ticket cũ).
        const { data } = await apiClient.post(`/projects/${projectId}/sse-ticket`)
        if (cancelled) return
        if (data?.ticket) {
          url = `${API_BASE}/projects/${projectId}/events?ticket=${encodeURIComponent(data.ticket)}`
        }
      } catch {
        /* ticket không lấy được → retry với ticket mới hoặc fallback polling */
      }
      if (cancelled) return
      if (!url) {
        if (attempt < SSE_RETRY_BACKOFF_MS.length) {
          const t = setTimeout(() => { if (!cancelled) openWithTicket(attempt + 1) }, SSE_RETRY_BACKOFF_MS[attempt])
          timersRef.current.push(t)
          return
        }
        setSseAvailable(false)
        return
      }
      const es = new EventSource(url)
      sourceRef.current = es
      let connected = false
      es.onmessage = (e) => { connected = true; applyEvent(e.data) }
      es.addEventListener('progress', (e) => { connected = true; applyEvent(e.data) })
      // done = stream closed (backend đã gửi terminal progress trước đó nếu có).
      // Không tự tạo completed — caller fetch DB để lấy truth.
      es.addEventListener('done', () => {
        setStreamClosed(true)
        try { es.close() } catch { /* noop */ }
        if (sourceRef.current === es) sourceRef.current = null
      })
      es.onerror = () => {
        try { es.close() } catch { /* noop */ }
        if (sourceRef.current === es) sourceRef.current = null
        if (cancelled || connected) {
          // Đã từng connect rồi mất kết nối đột ngột → coi như SSE gãy, fallback polling.
          // Không retry vô hạn để tránh request storm.
          if (!cancelled && connected) setSseAvailable(false)
          return
        }
        // Chưa connect được (ticket hết hạn / auth fail) → retry ticket mới với backoff giới hạn.
        if (attempt < SSE_RETRY_BACKOFF_MS.length) {
          const t = setTimeout(() => { if (!cancelled) openWithTicket(attempt + 1) }, SSE_RETRY_BACKOFF_MS[attempt])
          timersRef.current.push(t)
          return
        }
        setSseAvailable(false)
      }
    }

    openWithTicket()

    return () => {
      cancelled = true
      for (const t of timersRef.current) clearTimeout(t)
      timersRef.current = []
      try { sourceRef.current?.close() } catch { /* noop */ }
      sourceRef.current = null
    }
  }, [projectId, enabled])

  return { events, lastEvent, sseAvailable, streamClosed }
}
