import { Router } from 'express'
import crypto from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { sseAuthMiddleware, authMiddleware } from '../../middleware/auth.js'
import { requireProjectOwner } from '../../middleware/projectAccess.js'
import { queryOne, run } from '../../db/query.js'
import { sha256 } from '../../lib/crypto.js'
import { sendError } from '../../lib/httpError.js'
import eventBus from '../../pipeline/eventBus.js'

const router = Router()

export const SSE_TICKET_TTL_MS = 60 * 1000

// POST /api/v1/projects/:id/sse-ticket — cấp ticket single-use TTL 60s cho SSE.
// Frontend gọi bằng Bearer (axios), sau đó mở EventSource với ?ticket= (không để
// JWT dài hạn trong URL). Ticket gắn user+project, single-use, không log.
router.post('/projects/:id/sse-ticket', authMiddleware, requireProjectOwner, async (req, res) => {
  try {
    const ticket = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + SSE_TICKET_TTL_MS).toISOString()
    try {
      // expires_at lưu ISO (toISOString) nên so sánh bằng ISO hiện tại, không dùng
      // datetime('now') (format 'YYYY-MM-DD HH:MM:SS' lệch với ISO có 'T').
      await run(`DELETE FROM sse_tickets WHERE expires_at < ?`, [new Date().toISOString()])
    } catch (_) {}
    await run(
      `INSERT INTO sse_tickets (id, user_id, project_id, ticket_hash, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)`,
      [uuidv4(), req.user.id, req.project.id, sha256(ticket), expiresAt]
    )
    res.json({ ticket, expiresAt })
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message || 'Internal server error')
  }
})

// GET /api/v1/projects/:id/events — SSE tiến trình pipeline realtime (docs/06 §2.2).
// Event data: { stage, status, percent } — stage '__project__' là tiến độ tổng.
// - eventBus là process-local best-effort; DB polling mới là authoritative.
// - event 'progress' mang terminal payload authoritative (completed/failed khớp
//   projects.status); event 'done' chỉ nghĩa stream sắp đóng, frontend KHÔNG được
//   suy diễn completed từ done mà phải fetch project status.
// - nếu project đã completed/failed trước connect, gửi ngay terminal từ DB.
router.get('/projects/:id/events', sseAuthMiddleware, requireProjectOwner, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 3000\n\n')

  // Project đã terminal trước khi SSE connect → trả ngay state DB, không chờ event.
  try {
    const current = await queryOne(`SELECT status, progress FROM projects WHERE id = ?`, [req.project.id])
    if (current && ['completed', 'failed'].includes(String(current.status))) {
      const terminal = { stage: '__project__', status: String(current.status), percent: Number(current.progress ?? 100) }
      try {
        res.write(`event: progress\ndata: ${JSON.stringify(terminal)}\n\n`)
        res.write('event: done\ndata: {}\n\n')
      } catch (_) {}
      res.end()
      return
    }
  } catch (_) {}

  const unsubscribe = eventBus.subscribe(req.project.id, (payload) => {
    try {
      res.write(`event: progress\ndata: ${JSON.stringify(payload)}\n\n`)
      // Terminal statuses: 'completed' (chuẩn mới, khớp projects.status) +
      // 'success' (tương thích event cũ) + 'failed'.
      // done = stream closed, không phải completion — client phải dùng payload
      // progress terminal / fetch DB làm truth.
      if (payload.stage === '__project__' && ['completed', 'success', 'failed'].includes(payload.status)) {
        res.write('event: done\ndata: {}\n\n')
        cleanup()
        res.end()
      }
    } catch (_) {
      /* client đã ngắt */
    }
  })

  // Heartbeat giữ connection sống qua proxy
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n') } catch (_) {}
  }, 15000)

  function cleanup() {
    clearInterval(heartbeat)
    unsubscribe()
  }

  req.on('close', cleanup)
})

export default router
