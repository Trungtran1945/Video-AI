import { useEffect, useRef, useState } from 'react'
import { apiClient } from '@/api/client'

const API_BASE = import.meta.env.VITE_API_BASE || '/api/v1'

/**
 * Lắng nghe tiến trình pipeline realtime qua SSE GET /projects/:id/events.
 * Auth: fetch POST /sse-ticket (Bearer) rồi mở EventSource với ?ticket=
 * (single-use, TTL 60s) — KHÔNG để JWT dài hạn trong URL.
 *
  * Contract (DB-authoritative, race-safe):
  * - Hook này KHÔNG tự fallback polling. Khi SSE gãy (ticket fail, network
  *   error, stream closed, HOẶC backend phát event 'error' DB_UNAVAILABLE),
  *   hook chỉ set sseAvailable=false / streamClosed=true.
  *   Caller (ProjectDetail.jsx) chịu trách nhiệm polling GET /projects/:id
  *   khi sseAvailable===false. DB status là source of truth duy nhất.
  * - done chỉ nghĩa stream closed — KHÔNG tự suy diễn completed. Caller phải
  *   fetch project status (DB) để lấy truth.
  * - error (DB_UNAVAILABLE, retryable) nghĩa authoritative DB check thất bại —
  *   SSE không còn đáng tin, caller polling với backoff hợp lý, không storm.
 * - Ticket single-use nên mỗi retry phải xin ticket MỚI (không reuse).
 * - Retry giới hạn với backoff [1s, 2s, 5s]. Không retry vô hạn để tránh
 *   request storm. Chỉ 1 EventSource tại 1 thời điểm.
 * - Connection generation guard: mỗi connection attempt có generation id.
 *   Callback của EventSource cũ (onmessage/onerror/done/retry timer) không
 *   được mutate state/retry/close connection mới.
 *
 * Trả về: { events, lastEvent, sseAvailable, streamClosed }
 *  - events: map stage → { status, percent }
 */
export function useJobEvents(projectId, enabled = true) {
  const [events, setEvents] = useState({})
  const [lastEvent, setLastEvent] = useState(null)
  const [sseAvailable, setSseAvailable] = useState(true)
  const [streamClosed, setStreamClosed] = useState(false)
  const sourceRef = useRef(null)
  const timersRef = useRef([])
  const generationRef = useRef(0)

  useEffect(() => {
    if (!projectId || !enabled) return undefined
    let cancelled = false
    // New subscription lifecycle → new generation series. Old callbacks
    // captured a smaller gen and must become no-ops.
    generationRef.current += 1
    const lifecycleGen = generationRef.current
    setStreamClosed(false)
    setSseAvailable(true)

    // Chuẩn hoá vocabulary: backend cũ emit 'success' cho __project__,
    // backend mới emit 'completed' (khớp projects.status). Frontend chỉ dùng 'completed'.
    const normalize = (data) => {
      if (!data || typeof data !== 'object') return data
      if (data.stage === '__project__' && data.status === 'success') {
        return { ...data, status: 'completed' }
      }
      return data
    }

    const applyEvent = (gen, raw) => {
      if (cancelled || gen !== generationRef.current) return
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

    const clearTimer = (t) => {
      try { clearTimeout(t) } catch { /* noop */ }
      const idx = timersRef.current.indexOf(t)
      if (idx >= 0) timersRef.current.splice(idx, 1)
    }

    const scheduleRetry = (gen, attempt) => {
      if (cancelled || gen !== generationRef.current) return
      if (attempt >= SSE_RETRY_BACKOFF_MS.length) {
        if (gen === generationRef.current && !cancelled) setSseAvailable(false)
        return
      }
      const delay = SSE_RETRY_BACKOFF_MS[attempt]
      const t = setTimeout(() => {
        clearTimer(t)
        if (!cancelled && gen === generationRef.current) {
          generationRef.current += 1
          openWithTicket(attempt + 1, generationRef.current)
        }
      }, delay)
      timersRef.current.push(t)
    }

    const openWithTicket = async (attempt = 0, gen = lifecycleGen) => {
      if (cancelled || gen !== generationRef.current) return
      let url = null
      try {
        // Mỗi attempt xin ticket mới (single-use, không reuse ticket cũ).
        const { data } = await apiClient.post(`/projects/${projectId}/sse-ticket`)
        if (cancelled || gen !== generationRef.current) return
        if (data?.ticket) {
          url = `${API_BASE}/projects/${projectId}/events?ticket=${encodeURIComponent(data.ticket)}`
        }
      } catch {
        /* ticket không lấy được → retry với ticket mới (bounded) */
      }
      if (cancelled || gen !== generationRef.current) return
      if (!url) {
        scheduleRetry(gen, attempt)
        return
      }
      const es = new EventSource(url)
      // Only the current generation owns sourceRef. If a newer attempt
      // already replaced it, close this stale EventSource immediately.
      if (gen !== generationRef.current) {
        try { es.close() } catch { /* noop */ }
        return
      }
      // Close any previous EventSource before adopting the new one so only
      // one stream exists at a time; never close a newer stream from here.
      const prev = sourceRef.current
      sourceRef.current = es
      if (prev && prev !== es) {
        try { prev.close() } catch { /* noop */ }
      }
      let connected = false
      es.onmessage = (e) => {
        if (cancelled || gen !== generationRef.current) return
        if (sourceRef.current !== es) return
        connected = true
        applyEvent(gen, e.data)
      }
      const onProgress = (e) => {
        if (cancelled || gen !== generationRef.current) return
        if (sourceRef.current !== es) return
        connected = true
        applyEvent(gen, e.data)
      }
      es.addEventListener('progress', onProgress)
      // Backend DB failure: event 'error' { code:'DB_UNAVAILABLE', retryable }.
      // SSE không còn authoritative → đánh dấu unavailable để caller fallback
      // polling DB, không suy diễn terminal từ error.
      const onErrorEvent = () => {
        if (cancelled || gen !== generationRef.current) return
        if (sourceRef.current !== es) return
        setSseAvailable(false)
        setStreamClosed(true)
        try { es.close() } catch { /* noop */ }
        if (sourceRef.current === es) sourceRef.current = null
      }
      es.addEventListener('error', onErrorEvent)
      // done = stream closed (backend đã gửi terminal progress trước đó nếu có).
      // Không tự tạo completed — caller fetch DB để lấy truth.
      const onDone = () => {
        if (cancelled || gen !== generationRef.current) return
        if (sourceRef.current !== es) return
        setStreamClosed(true)
        try { es.close() } catch { /* noop */ }
        if (sourceRef.current === es) sourceRef.current = null
      }
      es.addEventListener('done', onDone)
      es.onerror = () => {
        if (cancelled || gen !== generationRef.current) {
          try { es.close() } catch { /* noop */ }
          return
        }
        if (sourceRef.current !== es) {
          try { es.close() } catch { /* noop */ }
          return
        }
        try { es.close() } catch { /* noop */ }
        if (sourceRef.current === es) sourceRef.current = null
        if (connected) {
          // Đã từng connect rồi mất kết nối đột ngột → coi như SSE gãy.
          // Không retry vô hạn để tránh request storm. Caller polling
          // (ProjectDetail) là fallback authoritative.
          setSseAvailable(false)
          return
        }
        // Chưa connect được (ticket hết hạn / auth fail) → retry ticket mới với backoff giới hạn.
        scheduleRetry(gen, attempt)
      }
    }

    openWithTicket(0, lifecycleGen)

    return () => {
      cancelled = true
      // Invalidate all pending callbacks/timers of this lifecycle.
      generationRef.current += 1
      for (const t of timersRef.current) {
        try { clearTimeout(t) } catch { /* noop */ }
      }
      timersRef.current = []
      try { sourceRef.current?.close() } catch { /* noop */ }
      sourceRef.current = null
    }
  }, [projectId, enabled])

  return { events, lastEvent, sseAvailable, streamClosed }
}
