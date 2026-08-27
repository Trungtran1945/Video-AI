import { Router } from 'express'
import { sseAuthMiddleware } from '../../middleware/auth.js'
import { requireProjectOwner } from '../../middleware/projectAccess.js'
import eventBus from '../../pipeline/eventBus.js'

const router = Router()
// SSE qua EventSource không gửi được Authorization header → sseAuthMiddleware
// chấp nhận thêm ?token=<accessToken> (frontend src/hooks/useJobEvents.js).
router.use(sseAuthMiddleware)

// GET /api/v1/projects/:id/events — SSE tiến trình pipeline realtime (docs/06 §2.2).
// Event data: { stage, status, percent } — stage '__project__' là tiến độ tổng.
router.get('/projects/:id/events', requireProjectOwner, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 3000\n\n')

  const unsubscribe = eventBus.subscribe(req.project.id, (payload) => {
    try {
      res.write(`event: progress\ndata: ${JSON.stringify(payload)}\n\n`)
      if (payload.stage === '__project__' && ['success', 'failed'].includes(payload.status)) {
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
