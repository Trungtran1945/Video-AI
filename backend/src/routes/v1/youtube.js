import { Router } from 'express'
import { authMiddleware } from '../../middleware/auth.js'
import { sendError } from '../../lib/httpError.js'
import { config } from '../../config.js'
import {
  YoutubeError,
  startOAuth,
  completeOAuth,
  getAccount,
  disconnectAccount,
} from '../../services/youtubeOAuthService.js'
import { hasActivePublish } from '../../services/youtubePublishService.js'

const router = Router()

function sendYoutubeError(res, err) {
  const code = err instanceof YoutubeError || err?.statusCode ? err.code : 'YOUTUBE_ERROR'
  const status = Number(err?.statusCode) || 500
  return sendError(res, status, code, err?.message || 'YouTube error')
}

function callbackRedirect(res, params) {
  const base = config.youtube.frontendUrl || ''
  const query = new URLSearchParams(params).toString()
  return res.redirect(302, `${base}/settings?${query}`)
}

// POST /api/v1/youtube/oauth/start
router.post('/oauth/start', authMiddleware, async (req, res) => {
  try {
    const result = await startOAuth(req.user.id)
    res.json(result)
  } catch (err) {
    sendYoutubeError(res, err)
  }
})

// GET /api/v1/youtube/oauth/callback?code&state — no auth: Google redirects the
// browser here; ownership comes from the single-use hashed state row.
router.get('/oauth/callback', async (req, res) => {
  try {
    if (req.query.error) return callbackRedirect(res, { youtube: 'error', reason: 'oauth_denied' })
    const code = typeof req.query.code === 'string' ? req.query.code : ''
    const state = typeof req.query.state === 'string' ? req.query.state : ''
    if (!code || !state) return callbackRedirect(res, { youtube: 'error', reason: 'invalid_state' })
    await completeOAuth({ code, state })
    return callbackRedirect(res, { youtube: 'connected' })
  } catch (err) {
    const known = new Set(['invalid_state', 'scope_missing', 'channel_not_found', 'token_exchange_failed', 'YOUTUBE_NOT_CONFIGURED'])
    const reason = known.has(err?.code) ? err.code : 'oauth_failed'
    return callbackRedirect(res, { youtube: 'error', reason })
  }
})

// GET /api/v1/youtube/account
router.get('/account', authMiddleware, async (req, res) => {
  try {
    res.json(await getAccount(req.user.id))
  } catch (err) {
    sendYoutubeError(res, err)
  }
})

// DELETE /api/v1/youtube/account
router.delete('/account', authMiddleware, async (req, res) => {
  try {
    if (await hasActivePublish(req.user.id)) {
      return sendError(res, 409, 'YOUTUBE_UPLOAD_ACTIVE', 'Đang có video được tải lên — không thể ngắt kết nối')
    }
    const result = await disconnectAccount(req.user.id)
    res.json(result)
  } catch (err) {
    sendYoutubeError(res, err)
  }
})

export default router
