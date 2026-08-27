import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { queryOne, run } from '../db/query.js'
import { sha256 } from '../lib/crypto.js'
import { sendError, ERR } from '../lib/httpError.js'

export function generateAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    config.jwtAccessSecret,
    { expiresIn: config.jwtAccessExpiresIn }
  )
}

export function generateRefreshToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    config.jwtRefreshSecret,
    { expiresIn: config.jwtRefreshExpiresIn }
  )
}

export async function storeRefreshToken(userId, plainRefresh) {
  const hash = sha256(plainRefresh)
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  await run(
    `UPDATE users SET refresh_token = ?, refresh_expires = ? WHERE id = ?`,
    [hash, expires, userId]
  )
}

export async function clearRefreshToken(userId) {
  await run(`UPDATE users SET refresh_token = NULL, refresh_expires = NULL WHERE id = ?`, [userId])
}

// Lấy token: Authorization: Bearer <token>; chỉ chấp nhận ?token= khi allowQueryToken
// (EventSource của SSE không gửi được header — frontend useJobEvents truyền ?token=).
export function extractBearerToken(req, { allowQueryToken = false } = {}) {
  const header = req.headers.authorization
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim()
  if (allowQueryToken && typeof req.query?.token === 'string' && req.query.token) {
    return req.query.token
  }
  return null
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.jwtAccessSecret)
}

// Verify access token
export function authMiddleware(req, res, next) {
  const token = extractBearerToken(req)
  if (!token) {
    return sendError(res, 401, ERR.AUTH_TOKEN, 'Authentication required')
  }
  try {
    req.user = verifyAccessToken(token)
    next()
  } catch (err) {
    return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid or expired token')
  }
}

// Auth cho SSE: header trước, fallback ?token= (chỉ dùng cho route events).
export function sseAuthMiddleware(req, res, next) {
  const token = extractBearerToken(req, { allowQueryToken: true })
  if (!token) {
    return sendError(res, 401, ERR.AUTH_TOKEN, 'Authentication required')
  }
  try {
    req.user = verifyAccessToken(token)
    next()
  } catch (err) {
    return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid or expired token')
  }
}

// Verify refresh token (in body.refreshToken or header x-refresh-token)
export async function refreshMiddleware(req, res, next) {
  const token = req.body?.refreshToken || req.headers['x-refresh-token']
  if (!token) {
    return sendError(res, 401, ERR.AUTH_TOKEN, 'Refresh token required')
  }
  try {
    const decoded = jwt.verify(token, config.jwtRefreshSecret)
    const user = await queryOne(`SELECT id, email, role, refresh_token, refresh_expires FROM users WHERE id = ?`, [decoded.id])
    if (!user || !user.refresh_token || user.refresh_token !== sha256(token)) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
    }
    if (user.refresh_expires && new Date(user.refresh_expires) < new Date()) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Refresh token expired')
    }
    req.user = decoded
    next()
  } catch (err) {
    return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || (roles.length && !roles.includes(req.user.role))) {
      return sendError(res, 403, ERR.AUTH_FORBIDDEN, 'Forbidden')
    }
    next()
  }
}

export default {
  generateAccessToken,
  generateRefreshToken,
  storeRefreshToken,
  clearRefreshToken,
  extractBearerToken,
  verifyAccessToken,
  authMiddleware,
  sseAuthMiddleware,
  refreshMiddleware,
  requireRole,
}
