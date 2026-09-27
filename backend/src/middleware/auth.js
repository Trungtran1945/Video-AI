import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { queryOne, run, runAffected } from '../db/query.js'
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
  // jti ngẫu nhiên mỗi lần rotate: 2 token ký trong cùng 1 giây (JWT iat chỉ
  // chính xác tới giây) không bao giờ giống hệt nhau, nên mệnh đề CAS
  // WHERE refresh_token=? không thể match nhầm cho request song song cũ.
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    config.jwtRefreshSecret,
    { expiresIn: config.jwtRefreshExpiresIn, jwtid: randomUUID() }
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

// Atomic compare-and-swap rotation: chỉ rotate khi hash cũ vẫn là hash đang
// lưu VÀ chưa hết hạn. affected===1 → winner; affected===0 → token đã bị
// rotate/invalid bởi request song song → 401. Chạy trong write queue hiện tại.
export async function rotateRefreshToken(userId, oldHash, plainRefresh) {
  const hash = sha256(plainRefresh)
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const affected = await runAffected(
    `UPDATE users SET refresh_token = ?, refresh_expires = ?
     WHERE id = ? AND refresh_token = ? AND refresh_expires > ?`,
    [hash, expires, userId, oldHash, new Date().toISOString()],
    { op: 'auth.refresh.rotate' }
  )
  return affected === 1
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
      // Single-use atomic claim: quyết định authenticate là DELETE CÓ ĐIỀU KIỆN
      // (ticket_hash + used=0 + chưa hết hạn + đúng project + đúng user).
      // SELECT ở trên chỉ đọc thông tin để trả 403 sai-project mà không đốt
      // ticket; DELETE dưới đây mới là claim nguyên tử. 100 request đồng thời
      // cùng ticket: write queue serialize → 1 request affected=1, 99 affected=0
      // → 401. Ticket hết hạn giữa SELECT và DELETE cũng affected=0 → 401.
      // Không log ticket.
      const claimed = await runAffected(
        `DELETE FROM sse_tickets
         WHERE ticket_hash = ? AND used = 0 AND expires_at > ?
           AND project_id = ? AND user_id = ?`,
        [sha256(ticket), new Date().toISOString(), row.project_id, row.user_id],
        { op: 'auth.sse.consume' }
      )
      if (claimed !== 1) {
        return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid or expired ticket')
      }
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
  requireRole,
}
