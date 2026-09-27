import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { queryOne, insert, withTransaction } from '../../db/query.js'
import {
  generateAccessToken,
  generateRefreshToken,
  storeRefreshToken,
  clearRefreshToken,
  rotateRefreshToken,
  authMiddleware,
  extractBearerToken,
  verifyAccessToken,
} from '../../middleware/auth.js'
import { sendError, ERR } from '../../lib/httpError.js'
import { config } from '../../config.js'

const router = Router()

function publicUser(u) {
  // users.credits is a legacy column — no longer exposed (hệ Xu đã bỏ, docs/00 §2.2)
  return { id: u.id, email: u.email, role: u.role, name: u.name || '' }
}

const REFRESH_COOKIE = 'refresh_token'
const REFRESH_COOKIE_PATH = '/api/v1/auth'

function readRefreshCookie(req) {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== REFRESH_COOKIE) continue
    try { return decodeURIComponent(part.slice(eq + 1).trim()) } catch (_) { return null }
  }
  return null
}

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true, secure: config.cookieSecure, sameSite: 'lax',
    path: REFRESH_COOKIE_PATH, maxAge: 7 * 24 * 60 * 60 * 1000,
  })
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: REFRESH_COOKIE_PATH,
  })
}

// Cookie là nguồn chính; body/x-refresh-token là fallback DEPRECATED
// (giữ 2 release cho client không phải trình duyệt — xem README, sẽ bỏ).
function readRefreshToken(req) {
  return readRefreshCookie(req) || req.body?.refreshToken || req.headers['x-refresh-token'] || null
}

// POST /api/v1/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body
    if (!email || !password) {
      return sendError(res, 400, ERR.VALIDATION, 'Email and password are required', { field: 'email,password' })
    }
    const existing = await queryOne(`SELECT id FROM users WHERE email = ?`, [email])
    if (existing) {
      return sendError(res, 409, 'EMAIL_EXISTS', 'Email already registered', { field: 'email' })
    }
    const hashed = await bcrypt.hash(password, 10)
    const user = await insert('users', {
      id: uuidv4(),
      email,
      password: hashed,
      role: 'user',
      name: name || '',
    })
    const accessToken = generateAccessToken(user)
    const refreshToken = generateRefreshToken(user)
    await storeRefreshToken(user.id, refreshToken)
    setRefreshCookie(res, refreshToken)
    res.json({ accessToken, user: publicUser(user) })
  } catch (err) {
    console.error('Register error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return sendError(res, 400, ERR.VALIDATION, 'Email and password are required', { field: 'email,password' })
    }
    const user = await queryOne(`SELECT * FROM users WHERE email = ?`, [email])
    if (!user || !(await bcrypt.compare(password, user.password))) {
          return sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password')
    }
    const accessToken = generateAccessToken(user)
    const refreshToken = generateRefreshToken(user)
    await storeRefreshToken(user.id, refreshToken)
    setRefreshCookie(res, refreshToken)
    res.json({ accessToken, user: publicUser(user) })
  } catch (err) {
    console.error('Login error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/auth/refresh — atomic CAS rotation (xem rotateRefreshToken).
router.post('/refresh', async (req, res) => {
  try {
    const token = readRefreshToken(req)
    if (!token) return sendError(res, 401, ERR.AUTH_TOKEN, 'Refresh token required')
    const jwt = (await import('jsonwebtoken')).default
    const { sha256 } = await import('../../lib/crypto.js')
    let decoded
    try {
      decoded = jwt.verify(token, config.jwtRefreshSecret)
    } catch (_) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
    }
    const user = await queryOne(`SELECT * FROM users WHERE id = ?`, [decoded.id])
    const oldHash = sha256(token)
    if (!user || user.refresh_token !== oldHash) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
    }
    if (user.refresh_expires && new Date(user.refresh_expires) < new Date()) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Refresh token expired')
    }
    const accessToken = generateAccessToken(user)
    const newRefresh = generateRefreshToken(user)
    const rotated = await rotateRefreshToken(user.id, oldHash, newRefresh)
    if (!rotated) return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
    setRefreshCookie(res, newRefresh)
    res.json({ accessToken, user: publicUser(user) })
  } catch (err) {
    // DB bận KHÔNG được trả 401 (sẽ logout oan client) → 503 retryable.
    if (err?.code === 'DB_WRITE_QUEUE_FULL' || err?.code === 'DB_PERSISTENCE_BLOCKED') {
      return sendError(res, 503, err.code, 'Database write queue is busy', { retryAfterMs: err.retryAfterMs })
    }
    return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
  }
})

// POST /api/v1/auth/logout — không bắt buộc access token còn hạn:
// browser chỉ cần xóa được cookie; xác thực bằng Bearer hoặc chính refresh cookie.
router.post('/logout', async (req, res) => {
  try {
    const cookieToken = readRefreshCookie(req)
    let userId = null
    const bearer = extractBearerToken(req)
    if (bearer) {
      try { userId = verifyAccessToken(bearer).id } catch (_) {}
    }
    if (!userId && cookieToken) {
      const jwt = (await import('jsonwebtoken')).default
      try { userId = jwt.verify(cookieToken, config.jwtRefreshSecret).id } catch (_) {}
    }
    if (userId) await clearRefreshToken(userId)
    clearRefreshCookie(res)
    res.json({ message: 'Logged out' })
  } catch (err) {
    console.error('Logout error:', err)
    clearRefreshCookie(res)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// GET /api/v1/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  const user = await queryOne(`SELECT id, email, role, name, created_date FROM users WHERE id = ?`, [req.user.id])
  if (!user) return sendError(res, 404, 'USER_NOT_FOUND', 'User not found')
  res.json(publicUser(user))
})

// POST /api/v1/auth/forgot-password  (no real email in dev; raw token may be
// echoed only when AUTH_DEV_RESET_TOKEN_IN_RESPONSE=true — never logged, never
// stored: the DB keeps only sha256(token))
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return sendError(res, 400, ERR.VALIDATION, 'Email is required', { field: 'email' })
    const user = await queryOne(`SELECT id FROM users WHERE email = ?`, [email])
    const out = { message: 'Nếu email tồn tại, liên kết đặt lại mật khẩu đã được gửi.' }
    if (user) {
      const { sha256 } = await import('../../lib/crypto.js')
      const { config } = await import('../../config.js')
      const token = uuidv4() + uuidv4().replace(/-/g, '')
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      await insert('reset_tokens', { email, token: sha256(token), expires_at: expires, used: 0 })
      if (config.authDevResetTokenInResponse) out.devToken = token
    }
    // Always return the same message to avoid leaking account existence
    res.json(out)
  } catch (err) {
    console.error('Forgot password error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/auth/reset-password — one-time atomic consume:
// claim (UPDATE ... used=1 WHERE used=0 AND expires_at>now) quyết định đúng 1
// người thắng; password update trong CÙNG transaction → fail là ROLLBACK (token
// không bị cháy). Đổi mật khẩu đồng thời thu hồi refresh token hiện tại.
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body
    if (!token || !newPassword) {
      return sendError(res, 400, ERR.VALIDATION, 'Token and new password are required', { field: 'token,newPassword' })
    }
    const { sha256 } = await import('../../lib/crypto.js')
    const tokenHash = sha256(token)
    const hashed = await bcrypt.hash(newPassword, 10)
    try {
      await withTransaction(async (tx) => {
        const claimed = await tx.runAffected(
          `UPDATE reset_tokens SET used = 1 WHERE token = ? AND used = 0 AND expires_at > ?`,
          [tokenHash, new Date().toISOString()],
          { op: 'auth.reset.claim' }
        )
        if (claimed !== 1) {
          // Phân biệt message cho client (read-only, không ảnh hưởng tính nguyên tử)
          const row = await tx.queryOne(`SELECT expires_at, used FROM reset_tokens WHERE token = ?`, [tokenHash])
          const expired = !!row && !row.used && new Date(row.expires_at) < new Date()
          const err = new Error(expired ? 'Reset token expired' : 'Invalid or used reset token')
          err.code = 'INVALID_TOKEN'
          throw err
        }
        const row = await tx.queryOne(`SELECT email FROM reset_tokens WHERE token = ?`, [tokenHash])
        const user = row ? await tx.queryOne(`SELECT id FROM users WHERE email = ?`, [row.email]) : null
        if (!user) {
          const err = new Error('Invalid reset token'); err.code = 'INVALID_TOKEN'; throw err
        }
        await tx.run(
          `UPDATE users SET password = ?, refresh_token = NULL, refresh_expires = NULL WHERE id = ?`,
          [hashed, user.id]
        )
      }, { op: 'auth.password.reset' })
    } catch (e) {
      if (e?.code === 'INVALID_TOKEN') return sendError(res, 400, 'INVALID_TOKEN', e.message)
      throw e
    }
    res.json({ message: 'Mật khẩu đã được cập nhật.' })
  } catch (err) {
    console.error('Reset password error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

export default router
