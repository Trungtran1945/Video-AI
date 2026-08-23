import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { queryOne, run } from '../db/query.js'
import { sha256 } from '../lib/crypto.js'

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

// Verify access token
export function authMiddleware(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required', code: 'UNAUTHORIZED' })
  }
  const token = header.split(' ')[1]
  try {
    req.user = jwt.verify(token, config.jwtAccessSecret)
    next()
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token', code: 'UNAUTHORIZED' })
  }
}

// Verify refresh token (in body.refreshToken or header x-refresh-token)
export async function refreshMiddleware(req, res, next) {
  const token = req.body?.refreshToken || req.headers['x-refresh-token']
  if (!token) {
    return res.status(401).json({ message: 'Refresh token required', code: 'UNAUTHORIZED' })
  }
  try {
    const decoded = jwt.verify(token, config.jwtRefreshSecret)
    const user = await queryOne(`SELECT id, email, role, refresh_token, refresh_expires FROM users WHERE id = ?`, [decoded.id])
    if (!user || !user.refresh_token || user.refresh_token !== sha256(token)) {
      return res.status(401).json({ message: 'Invalid refresh token', code: 'UNAUTHORIZED' })
    }
    if (user.refresh_expires && new Date(user.refresh_expires) < new Date()) {
      return res.status(401).json({ message: 'Refresh token expired', code: 'UNAUTHORIZED' })
    }
    req.user = decoded
    next()
  } catch (err) {
    return res.status(401).json({ message: 'Invalid refresh token', code: 'UNAUTHORIZED' })
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || (roles.length && !roles.includes(req.user.role))) {
      return res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' })
    }
    next()
  }
}

export default {
  generateAccessToken,
  generateRefreshToken,
  storeRefreshToken,
  clearRefreshToken,
  authMiddleware,
  refreshMiddleware,
  requireRole,
}
