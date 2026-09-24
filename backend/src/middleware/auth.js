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
// (legacy SSE fallback — frontend mới dùng ?ticket= single-use, xem sseAuthMiddleware).
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

// Auth cho SSE: ưu tiên Authorization header, sau đó ?ticket= (single-use,
// TTL ngắn, không chứa secret thật trong URL), cuối cùng fallback ?token= JWT
// dài hạn (deprecated — giữ 1 release để client cũ không vỡ, frontend mới phải
// dùng ticket). Không log token/ticket ở bất kỳ nhánh nào.
export async function sseAuthMiddleware(req, res, next) {
  const header = req.headers.authorization
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = verifyAccessToken(header.slice(7).trim())
      return next()
    } catch (_) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid or expired token')
    }
  }
  const ticket = typeof req.query?.ticket === 'string' && req.query.ticket ? req.query.ticket : null
  if (ticket) {
    try {
      const row = await queryOne(`SELECT * FROM sse_tickets WHERE ticket_hash = ?`, [sha256(ticket)])
      if (!row || row.used) return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid or expired ticket')
      if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
        try { await run(`DELETE FROM sse_tickets WHERE ticket_hash = ?`, [sha256(ticket)]) } catch (_) {}
        return sendError(res, 401, ERR.AUTH_TOKEN, 'Ticket expired')
      }
      if (req.params?.id && String(row.project_id) !== String(req.params.id)) {
        return sendError(res, 403, ERR.AUTH_FORBIDDEN, 'Ticket không thuộc project này')
      }
      const user = await queryOne(`SELECT id, email, role FROM users WHERE id = ?`, [row.user_id])
      if (!user) return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid ticket user')
      // Single-use: consume ngay tại auth để không reuse vô hạn.
      // Nếu SSE connect fail sau auth, ticket đã mất — frontend phải xin ticket
      // mới và retry với backoff giới hạn (xem useJobEvents), không reuse.
      try { await run(`DELETE FROM sse_tickets WHERE ticket_hash = ?`, [sha256(ticket)]) } catch (_) {}
      req.user = { id: user.id, email: user.email, role: user.role }
      req.sseTicket = true
      return next()
    } catch (_) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid ticket')
    }
  }
  // Legacy fallback: ?token=<JWT> (deprecated, sẽ chặn sau 1 release).
  const legacy = typeof req.query?.token === 'string' && req.query.token ? req.query.token : null
  if (legacy) {
    try {
      req.user = verifyAccessToken(legacy)
      return next()
    } catch (_) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid or expired token')
    }
  }
  return sendError(res, 401, ERR.AUTH_TOKEN, 'Authentication required')
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
