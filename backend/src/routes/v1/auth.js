import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { queryOne, insert, updateById, run } from '../../db/query.js'
import {
  generateAccessToken,
  generateRefreshToken,
  storeRefreshToken,
  clearRefreshToken,
  authMiddleware,
} from '../../middleware/auth.js'
import { sendError, ERR } from '../../lib/httpError.js'

const router = Router()

function publicUser(u) {
  // users.credits is a legacy column — no longer exposed (hệ Xu đã bỏ, docs/00 §2.2)
  return { id: u.id, email: u.email, role: u.role, name: u.name || '' }
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
    res.json({ accessToken, refreshToken, user: publicUser(user) })
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
    res.json({ accessToken, refreshToken, user: publicUser(user) })
  } catch (err) {
    console.error('Login error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const token = req.body?.refreshToken || req.headers['x-refresh-token']
    if (!token) return sendError(res, 401, ERR.AUTH_TOKEN, 'Refresh token required')
    // Verify + rotate
    const jwt = (await import('jsonwebtoken')).default
    const { config } = await import('../../config.js')
    const decoded = jwt.verify(token, config.jwtRefreshSecret)
    const user = await queryOne(`SELECT * FROM users WHERE id = ?`, [decoded.id])
    const { sha256 } = await import('../../lib/crypto.js')
    if (!user || user.refresh_token !== sha256(token)) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
    }
    if (user.refresh_expires && new Date(user.refresh_expires) < new Date()) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Refresh token expired')
    }
    const accessToken = generateAccessToken(user)
    const newRefresh = generateRefreshToken(user)
    await storeRefreshToken(user.id, newRefresh)
    res.json({ accessToken, refreshToken: newRefresh, user: publicUser(user) })
  } catch (err) {
    return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
  }
})

// POST /api/v1/auth/logout
router.post('/logout', authMiddleware, async (req, res) => {
  await clearRefreshToken(req.user.id)
  res.json({ message: 'Logged out' })
})

// GET /api/v1/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  const user = await queryOne(`SELECT id, email, role, name, created_date FROM users WHERE id = ?`, [req.user.id])
  if (!user) return sendError(res, 404, 'USER_NOT_FOUND', 'User not found')
  res.json(publicUser(user))
})

// POST /api/v1/auth/forgot-password  (no real email in dev; token is returned/logged)
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return sendError(res, 400, ERR.VALIDATION, 'Email is required', { field: 'email' })
    const user = await queryOne(`SELECT id FROM users WHERE email = ?`, [email])
    if (user) {
      const token = uuidv4() + uuidv4().replace(/-/g, '')
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      await insert('reset_tokens', { email, token, expires_at: expires, used: 0 })
      console.log(`[dev] password reset token for ${email}: ${token}`)
    }
    // Always return the same message to avoid leaking account existence
    res.json({ message: 'Nếu email tồn tại, liên kết đặt lại mật khẩu đã được gửi.' })
  } catch (err) {
    console.error('Forgot password error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body
    if (!token || !newPassword) return sendError(res, 400, ERR.VALIDATION, 'Token and new password are required', { field: 'token,newPassword' })
    const row = await queryOne(`SELECT * FROM reset_tokens WHERE token = ?`, [token])
    if (!row || row.used) return sendError(res, 400, 'INVALID_TOKEN', 'Invalid or used reset token')
    if (new Date(row.expires_at) < new Date()) return sendError(res, 400, 'INVALID_TOKEN', 'Reset token expired')
    const user = await queryOne(`SELECT id FROM users WHERE email = ?`, [row.email])
    if (!user) return sendError(res, 400, 'INVALID_TOKEN', 'Invalid reset token')
    const hashed = await bcrypt.hash(newPassword, 10)
    await updateById('users', user.id, { password: hashed })
    await run(`UPDATE reset_tokens SET used = 1 WHERE token = ?`, [token])
    res.json({ message: 'Mật khẩu đã được cập nhật.' })
  } catch (err) {
    console.error('Reset password error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

export default router
