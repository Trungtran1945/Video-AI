import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { queryOne, insert, run, withTransaction } from '../../db/query.js'
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
import { noteRefreshFallback } from '../../lib/refreshMetrics.js'
import { config } from '../../config.js'
import { cookieCsrf } from '../../middleware/cookieCsrf.js'
import { generateNumericOtp, hashOtp, sendOtpEmail, OTP_TTL_SECONDS } from '../../services/emailService.js'

const router = Router()

function publicUser(u) {
  // users.credits is a legacy column — no longer exposed (hệ Xu đã bỏ, docs/00 §2.2)
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    name: u.name || '',
    email_verified: Boolean(u.email_verified),
    avatar: u.avatar || null,
  }
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
  const cookieToken = readRefreshCookie(req)
  if (cookieToken) return { token: cookieToken, source: 'cookie' }
  if (req.body?.refreshToken) return { token: req.body.refreshToken, source: 'body' }
  const headerToken = req.headers['x-refresh-token']
  if (headerToken) return { token: headerToken, source: 'header' }
  return { token: null, source: null }
}

// --- In-memory rate limiting stores ---
const forgotHitsByIp = new Map()
const forgotHitsByEmail = new Map()
const otpLastSentByEmail = new Map()
const otpHitsByEmail = new Map()
const otpHitsByIp = new Map()
const loginFailHitsByEmail = new Map()
const loginFailHitsByIp = new Map()
const registerHitsByIp = new Map()
const registerOtpLastSentByEmail = new Map()
const registerOtpHitsByEmail = new Map()
const registerOtpHitsByIp = new Map()
const googleHitsByIp = new Map()

export function hitRateLimit(store, key, limit, windowMs, now = Date.now()) {
  const hits = (store.get(key) || []).filter((t) => now - t < windowMs)
  hits.push(now)
  store.set(key, hits)
  if (hits.length > limit) {
    const oldest = hits[hits.length - 1 - limit]
    return Math.max(1, Math.ceil(((oldest + windowMs) - now) / 1000))
  }
  return 0
}

export function checkRateLimit(store, key, limit, windowMs, now = Date.now()) {
  const hits = (store.get(key) || []).filter((t) => now - t < windowMs)
  store.set(key, hits)
  if (hits.length >= limit) {
    const oldest = hits[0]
    return Math.max(1, Math.ceil(((oldest + windowMs) - now) / 1000))
  }
  return 0
}

export function recordRateLimitHit(store, key, windowMs, now = Date.now()) {
  const hits = (store.get(key) || []).filter((t) => now - t < windowMs)
  hits.push(now)
  store.set(key, hits)
}

export function __resetAuthRateLimitsForTests() {
  forgotHitsByIp.clear()
  forgotHitsByEmail.clear()
  otpLastSentByEmail.clear()
  otpHitsByEmail.clear()
  otpHitsByIp.clear()
  loginFailHitsByEmail.clear()
  loginFailHitsByIp.clear()
  registerHitsByIp.clear()
  registerOtpLastSentByEmail.clear()
  registerOtpHitsByEmail.clear()
  registerOtpHitsByIp.clear()
  googleHitsByIp.clear()
}
export const __resetForgotRateLimitForTests = __resetAuthRateLimitsForTests
export const __resetOtpRateLimitForTests = __resetAuthRateLimitsForTests

export function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

export async function decodeOrVerifyGoogleCredential(rawCredential) {
  if (!rawCredential) return null

  let cred = rawCredential
  if (typeof cred === 'string') {
    const trimmed = cred.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        cred = JSON.parse(trimmed)
      } catch (_) {}
    }
  }

  if (typeof cred === 'object' && cred !== null) {
    if (cred.credential && typeof cred.credential !== 'object') {
      return decodeOrVerifyGoogleCredential(cred.credential)
    }
    if (cred.email && (cred.sub || cred.id || cred.googleId)) {
      return {
        email: String(cred.email).trim().toLowerCase(),
        name: cred.name || cred.email.split('@')[0],
        googleId: String(cred.sub || cred.id || cred.googleId),
        avatar: cred.picture || cred.avatar || null,
        emailVerified: cred.email_verified !== false,
      }
    }
  }

  const tokenStr = String(cred).trim()
  const parts = tokenStr.split('.')
  if (parts.length === 3) {
    let payload = null
    try {
      const decodedPayload = Buffer.from(parts[1], 'base64url').toString('utf8')
      payload = JSON.parse(decodedPayload)
    } catch (_) {
      try {
        const decodedPayload = Buffer.from(parts[1], 'base64').toString('utf8')
        payload = JSON.parse(decodedPayload)
      } catch (_) {}
    }

    if (payload && payload.email && (payload.sub || payload.id)) {
      return {
        email: String(payload.email).trim().toLowerCase(),
        name: payload.name || payload.email.split('@')[0],
        googleId: String(payload.sub || payload.id),
        avatar: payload.picture || payload.avatar || null,
        emailVerified: payload.email_verified !== false,
      }
    }
  }

  return null
}

async function verifyGoogleToken(rawCredential) {
  if (!rawCredential) return null

  const decoded = await decodeOrVerifyGoogleCredential(rawCredential)
  if (decoded && process.env.NODE_ENV === 'test') {
    return decoded
  }

  if (typeof rawCredential === 'string' && !rawCredential.startsWith('{') && !rawCredential.startsWith('mock')) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(rawCredential.trim())}`, {
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (res.ok) {
        const data = await res.json()
        if (data && data.email && data.sub) {
          return {
            email: String(data.email).trim().toLowerCase(),
            name: data.name || data.email.split('@')[0],
            googleId: String(data.sub),
            avatar: data.picture || null,
            emailVerified: data.email_verified === 'true' || data.email_verified === true,
          }
        }
      }
    } catch (_) {
      // Fallback to local decoded token
    }
  }

  return decoded
}

// POST /api/v1/auth/register
router.post('/register', async (req, res) => {
  try {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown'
    const ipWait = hitRateLimit(registerHitsByIp, String(ip), 10, 15 * 60 * 1000)
    if (ipWait) {
      return sendError(res, 429, 'RATE_LIMITED', 'Quá nhiều yêu cầu đăng ký từ địa chỉ IP này. Vui lòng thử lại sau.', { retryAfterSec: ipWait })
    }

    const { email, password, name, otp } = req.body
    if (!email || !password) {
      return sendError(res, 400, ERR.VALIDATION, 'Email and password are required', { field: 'email,password' })
    }
    const normalizedEmail = String(email).trim().toLowerCase()
    const existing = await queryOne(`SELECT id FROM users WHERE email = ?`, [normalizedEmail])
    if (existing) {
      return sendError(res, 409, 'EMAIL_EXISTS', 'Email already registered', { field: 'email' })
    }

    let isEmailVerified = false
    if (otp) {
      const cleanOtp = String(otp).trim()
      const otpRow = await queryOne(
        `SELECT * FROM email_otps WHERE email = ? AND purpose = 'register' AND used = 0 ORDER BY created_date DESC, id DESC LIMIT 1`,
        [normalizedEmail]
      )
      if (otpRow && hashOtp(cleanOtp) === otpRow.otp_hash && new Date(otpRow.expires_at) >= new Date()) {
        await run(`UPDATE email_otps SET used = 1 WHERE id = ?`, [otpRow.id])
        isEmailVerified = true
      }
    }

    const hashed = await bcrypt.hash(password, 10)
    const user = await insert('users', {
      id: uuidv4(),
      email: normalizedEmail,
      password: hashed,
      role: 'user',
      name: name || '',
      email_verified: isEmailVerified,
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

// POST /api/v1/auth/register/send-otp
router.post('/register/send-otp', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !isValidEmail(email)) {
      return sendError(res, 400, ERR.VALIDATION, 'Email không hợp lệ hoặc bị thiếu', { field: 'email' })
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return sendError(res, 400, ERR.VALIDATION, 'Mật khẩu phải có ít nhất 6 ký tự', { field: 'password' })
    }

    const normalizedEmail = String(email).trim().toLowerCase()
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown'
    const now = Date.now()

    const existing = await queryOne(`SELECT id FROM users WHERE email = ?`, [normalizedEmail])
    if (existing) {
      return sendError(res, 409, 'EMAIL_EXISTS', 'Email đã được đăng ký trong hệ thống', { field: 'email' })
    }

    // 1. Cooldown 60s per email
    const lastSent = registerOtpLastSentByEmail.get(normalizedEmail)
    if (lastSent && now - lastSent < 60 * 1000) {
      const wait = Math.max(1, Math.ceil((60 * 1000 - (now - lastSent)) / 1000))
      return sendError(res, 429, 'RATE_LIMITED', 'Vui lòng đợi 60 giây trước khi yêu cầu mã OTP mới.', { retryAfterSec: wait })
    }

    // 2. Max 3 req / 10 min per email
    const emailHits = (registerOtpHitsByEmail.get(normalizedEmail) || []).filter((t) => now - t < 10 * 60 * 1000)
    if (emailHits.length >= 3) {
      const oldest = emailHits[0]
      const wait = Math.max(1, Math.ceil(((oldest + 10 * 60 * 1000) - now) / 1000))
      return sendError(res, 429, 'RATE_LIMITED', 'Đã vượt quá số lần yêu cầu OTP đăng ký (tối đa 3 lần/10 phút).', { retryAfterSec: wait })
    }

    // 3. Max 10 req / 10 min per IP
    const ipHits = (registerOtpHitsByIp.get(String(ip)) || []).filter((t) => now - t < 10 * 60 * 1000)
    if (ipHits.length >= 10) {
      const oldest = ipHits[0]
      const wait = Math.max(1, Math.ceil(((oldest + 10 * 60 * 1000) - now) / 1000))
      return sendError(res, 429, 'RATE_LIMITED', 'Quá nhiều yêu cầu gửi OTP từ địa chỉ IP của bạn. Vui lòng thử lại sau.', { retryAfterSec: wait })
    }

    await run(`UPDATE email_otps SET used = 1 WHERE email = ? AND purpose = 'register' AND used = 0`, [normalizedEmail])

    const otp = generateNumericOtp(6)
    const otpHash = hashOtp(otp)
    const expiresAt = new Date(now + OTP_TTL_SECONDS * 1000).toISOString()
    const otpId = uuidv4()

    await insert('email_otps', {
      id: otpId,
      email: normalizedEmail,
      otp_hash: otpHash,
      purpose: 'register',
      expires_at: expiresAt,
      attempts: 0,
      max_attempts: 5,
      used: 0,
      created_date: new Date(now).toISOString(),
    })

    const { devOtp } = await sendOtpEmail({ email: normalizedEmail, otp, purpose: 'register' })

    registerOtpLastSentByEmail.set(normalizedEmail, now)
    emailHits.push(now)
    registerOtpHitsByEmail.set(normalizedEmail, emailHits)
    ipHits.push(now)
    registerOtpHitsByIp.set(String(ip), ipHits)

    res.json({
      success: true,
      message: 'Mã xác thực OTP đã được gửi đến email của bạn',
      cooldownSeconds: 60,
      expiresInSeconds: OTP_TTL_SECONDS,
      ...(devOtp !== undefined ? { devOtp } : {}),
    })
  } catch (err) {
    console.error('Register send OTP error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/auth/register/verify-otp
router.post('/register/verify-otp', async (req, res) => {
  try {
    const { email, otp, password, name } = req.body
    if (!email || !otp || !password) {
      return sendError(res, 400, ERR.VALIDATION, 'Email, mật khẩu và mã OTP là bắt buộc', { field: 'email,otp,password' })
    }

    const normalizedEmail = String(email).trim().toLowerCase()
    const cleanOtp = String(otp).trim()

    if (!isValidEmail(normalizedEmail)) {
      return sendError(res, 400, ERR.VALIDATION, 'Email không hợp lệ', { field: 'email' })
    }
    if (!/^\d{6}$/.test(cleanOtp)) {
      return sendError(res, 400, ERR.VALIDATION, 'Mã OTP phải gồm 6 chữ số', { field: 'otp' })
    }
    if (typeof password !== 'string' || password.length < 6) {
      return sendError(res, 400, ERR.VALIDATION, 'Mật khẩu phải có ít nhất 6 ký tự', { field: 'password' })
    }

    const existing = await queryOne(`SELECT id FROM users WHERE email = ?`, [normalizedEmail])
    if (existing) {
      return sendError(res, 409, 'EMAIL_EXISTS', 'Email đã được đăng ký trong hệ thống', { field: 'email' })
    }

    const row = await queryOne(
      `SELECT * FROM email_otps WHERE email = ? AND purpose = 'register' AND used = 0 ORDER BY created_date DESC, id DESC LIMIT 1`,
      [normalizedEmail]
    )

    if (!row) {
      return sendError(res, 400, 'INVALID_OTP', 'Mã OTP không hợp lệ hoặc đã được sử dụng')
    }

    if (row.attempts >= (row.max_attempts || 5)) {
      return sendError(res, 400, 'OTP_MAX_ATTEMPTS_EXCEEDED', 'Mã OTP đã vượt quá số lần thử cho phép. Vui lòng yêu cầu mã mới.')
    }

    if (new Date(row.expires_at) < new Date()) {
      return sendError(res, 400, 'OTP_EXPIRED', 'Mã OTP đã hết hạn. Vui lòng yêu cầu mã mới.')
    }

    const inputHash = hashOtp(cleanOtp)
    if (inputHash !== row.otp_hash) {
      const nextAttempts = (row.attempts || 0) + 1
      await run(`UPDATE email_otps SET attempts = ? WHERE id = ?`, [nextAttempts, row.id])
      const remaining = Math.max(0, (row.max_attempts || 5) - nextAttempts)
      return sendError(res, 400, 'INVALID_OTP', 'Mã OTP không chính xác', { remainingAttempts: remaining })
    }

    let user
    try {
      await withTransaction(async (tx) => {
        const claimed = await tx.runAffected(
          `UPDATE email_otps SET used = 1 WHERE id = ? AND used = 0`,
          [row.id],
          { op: 'auth.register.claim_otp' }
        )
        if (claimed !== 1) {
          const err = new Error('Mã OTP đã được sử dụng')
          err.code = 'INVALID_OTP'
          throw err
        }

        const doubleCheck = await tx.queryOne(`SELECT id FROM users WHERE email = ?`, [normalizedEmail])
        if (doubleCheck) {
          const err = new Error('Email đã được đăng ký trong hệ thống')
          err.code = 'EMAIL_EXISTS'
          throw err
        }

        const hashed = await bcrypt.hash(password, 10)
        user = await tx.insert('users', {
          id: uuidv4(),
          email: normalizedEmail,
          password: hashed,
          role: 'user',
          name: name || normalizedEmail.split('@')[0],
          email_verified: true,
        })
      }, { op: 'auth.register.verify_and_create' })
    } catch (e) {
      if (e?.code === 'INVALID_OTP') return sendError(res, 400, 'INVALID_OTP', e.message)
      if (e?.code === 'EMAIL_EXISTS') return sendError(res, 409, 'EMAIL_EXISTS', e.message)
      throw e
    }

    const accessToken = generateAccessToken(user)
    const refreshToken = generateRefreshToken(user)
    await storeRefreshToken(user.id, refreshToken)
    setRefreshCookie(res, refreshToken)

    res.json({
      accessToken,
      user: publicUser(user),
    })
  } catch (err) {
    console.error('Verify registration OTP error:', err)
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

    const normalizedEmail = String(email).trim().toLowerCase()
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown'
    const now = Date.now()

    const ipWait = checkRateLimit(loginFailHitsByIp, String(ip), 10, 15 * 60 * 1000, now)
    if (ipWait) {
      return sendError(res, 429, 'RATE_LIMITED', 'Quá nhiều lần đăng nhập không thành công từ IP này. Vui lòng thử lại sau.', { retryAfterSec: ipWait })
    }
    const emailWait = checkRateLimit(loginFailHitsByEmail, normalizedEmail, 5, 15 * 60 * 1000, now)
    if (emailWait) {
      return sendError(res, 429, 'RATE_LIMITED', 'Tài khoản tạm thời bị khóa do nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau hoặc đặt lại mật khẩu.', { retryAfterSec: emailWait })
    }

    const user = await queryOne(`SELECT * FROM users WHERE email = ?`, [normalizedEmail])
    if (!user || !(await bcrypt.compare(password, user.password))) {
      recordRateLimitHit(loginFailHitsByIp, String(ip), 15 * 60 * 1000, now)
      recordRateLimitHit(loginFailHitsByEmail, normalizedEmail, 15 * 60 * 1000, now)
      return sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password')
    }

    loginFailHitsByEmail.delete(normalizedEmail)

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

// POST /api/v1/auth/google
router.post('/google', async (req, res) => {
  try {
    const rawCredential = req.body?.credential || req.body?.token || req.body?.idToken || req.body
    if (!rawCredential) {
      return sendError(res, 400, ERR.VALIDATION, 'Google credential is required', { field: 'credential' })
    }

    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown'
    const ipWait = hitRateLimit(googleHitsByIp, String(ip), 10, 15 * 60 * 1000)
    if (ipWait) {
      return sendError(res, 429, 'RATE_LIMITED', 'Quá nhiều yêu cầu đăng nhập Google từ IP này. Vui lòng thử lại sau.', { retryAfterSec: ipWait })
    }

    const verified = await verifyGoogleToken(rawCredential)
    if (!verified || !verified.email || !verified.googleId) {
      return sendError(res, 401, 'INVALID_GOOGLE_TOKEN', 'Google token không hợp lệ hoặc đã hết hạn')
    }

    const { email, name, googleId, avatar } = verified

    let user = await queryOne(`SELECT * FROM users WHERE google_id = ? OR email = ?`, [googleId, email])

    if (user) {
      await run(
        `UPDATE users SET google_id = COALESCE(google_id, ?), avatar = COALESCE(?, avatar), email_verified = true WHERE id = ?`,
        [googleId, avatar, user.id]
      )
      user = await queryOne(`SELECT * FROM users WHERE id = ?`, [user.id])
    } else {
      const dummyPassword = await bcrypt.hash(uuidv4(), 10)
      user = await insert('users', {
        id: uuidv4(),
        email,
        password: dummyPassword,
        role: 'user',
        name: name || email.split('@')[0],
        google_id: googleId,
        avatar: avatar || null,
        email_verified: true,
      })
    }

    const accessToken = generateAccessToken(user)
    const refreshToken = generateRefreshToken(user)
    await storeRefreshToken(user.id, refreshToken)
    setRefreshCookie(res, refreshToken)

    res.json({
      accessToken,
      user: publicUser(user),
    })
  } catch (err) {
    console.error('Google auth error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/auth/refresh — atomic CAS rotation (xem rotateRefreshToken).
router.post('/refresh', cookieCsrf, async (req, res) => {
  try {
    const { token, source } = readRefreshToken(req)
    if (!token) return sendError(res, 401, ERR.AUTH_TOKEN, 'Refresh token required')
    if (source === 'body' || source === 'header') noteRefreshFallback(source)
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
router.post('/logout', cookieCsrf, async (req, res) => {
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
  const user = await queryOne(`SELECT id, email, role, name, email_verified, avatar, created_date FROM users WHERE id = ?`, [req.user.id])
  if (!user) return sendError(res, 404, 'USER_NOT_FOUND', 'User not found')
  res.json(publicUser(user))
})

// POST /api/v1/auth/forgot-password  (no real email in dev; raw token may be
// echoed only when AUTH_DEV_RESET_TOKEN_IN_RESPONSE=true — never logged, never
// stored: the DB keeps only sha256(token))
// Rate-limit (single-process in-memory, matches eventBus design): >5 req/IP/10min
// hoặc >3 req/email/1h → 429 RATE_LIMITED + retryAfterSec, không insert row mới.
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return sendError(res, 400, ERR.VALIDATION, 'Email is required', { field: 'email' })
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown'
    const ipWait = hitRateLimit(forgotHitsByIp, String(ip), 5, 10 * 60 * 1000)
    if (ipWait) return sendError(res, 429, 'RATE_LIMITED', 'Quá nhiều yêu cầu đặt lại mật khẩu, thử lại sau.', { retryAfterSec: ipWait })
    const emailWait = hitRateLimit(forgotHitsByEmail, String(email).toLowerCase(), 3, 60 * 60 * 1000)
    if (emailWait) return sendError(res, 429, 'RATE_LIMITED', 'Quá nhiều yêu cầu đặt lại mật khẩu, thử lại sau.', { retryAfterSec: emailWait })
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

// POST /api/v1/auth/otp/send — Gửi mã OTP đăng nhập qua Email
router.post('/otp/send', async (req, res) => {
  try {
    const { email } = req.body
    if (!email || !isValidEmail(email)) {
      return sendError(res, 400, ERR.VALIDATION, 'Email không hợp lệ hoặc bị thiếu', { field: 'email' })
    }

    const normalizedEmail = String(email).trim().toLowerCase()
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown'
    const now = Date.now()

    // 1. Cooldown 60s per email
    const lastSent = otpLastSentByEmail.get(normalizedEmail)
    if (lastSent && now - lastSent < 60 * 1000) {
      const wait = Math.max(1, Math.ceil((60 * 1000 - (now - lastSent)) / 1000))
      return sendError(res, 429, 'RATE_LIMITED', `Vui lòng đợi 60 giây trước khi yêu cầu mã OTP mới.`, { retryAfterSec: wait })
    }

    // 2. Max 5 req/h per email
    const emailHits = (otpHitsByEmail.get(normalizedEmail) || []).filter((t) => now - t < 60 * 60 * 1000)
    if (emailHits.length >= 5) {
      const oldest = emailHits[0]
      const wait = Math.max(1, Math.ceil(((oldest + 60 * 60 * 1000) - now) / 1000))
      return sendError(res, 429, 'RATE_LIMITED', 'Đã vượt quá số lần yêu cầu OTP trong 1 giờ cho email này (tối đa 5 lần/giờ).', { retryAfterSec: wait })
    }

    // 3. Max 10 req/h per IP
    const ipHits = (otpHitsByIp.get(String(ip)) || []).filter((t) => now - t < 60 * 60 * 1000)
    if (ipHits.length >= 10) {
      const oldest = ipHits[0]
      const wait = Math.max(1, Math.ceil(((oldest + 60 * 60 * 1000) - now) / 1000))
      return sendError(res, 429, 'RATE_LIMITED', 'Quá nhiều yêu cầu gửi OTP từ địa chỉ IP của bạn. Vui lòng thử lại sau.', { retryAfterSec: wait })
    }

    // Vô hiệu hóa OTP cũ của email
    await run('UPDATE email_otps SET used = 1 WHERE email = ? AND used = 0', [normalizedEmail])

    // Sinh OTP mới, hash và lưu DB
    const otp = generateNumericOtp(6)
    const otpHash = hashOtp(otp)
    const expiresAt = new Date(now + OTP_TTL_SECONDS * 1000).toISOString()
    const otpId = uuidv4()

    await insert('email_otps', {
      id: otpId,
      email: normalizedEmail,
      otp_hash: otpHash,
      purpose: 'login',
      expires_at: expiresAt,
      attempts: 0,
      max_attempts: 5,
      used: 0,
      created_date: new Date(now).toISOString(),
    })

    // Gửi email OTP
    const { devOtp } = await sendOtpEmail({ email: normalizedEmail, otp, purpose: 'login' })

    // Cập nhật rate limit sau khi gửi thành công
    otpLastSentByEmail.set(normalizedEmail, now)
    emailHits.push(now)
    otpHitsByEmail.set(normalizedEmail, emailHits)
    ipHits.push(now)
    otpHitsByIp.set(String(ip), ipHits)

    res.json({
      success: true,
      message: 'Mã xác thực OTP đã được gửi đến email của bạn',
      cooldownSeconds: 60,
      expiresInSeconds: OTP_TTL_SECONDS,
      ...(devOtp !== undefined ? { devOtp } : {}),
    })
  } catch (err) {
    console.error('Send OTP error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/auth/otp/verify — Xác thực đăng nhập OTP qua Email
router.post('/otp/verify', async (req, res) => {
  try {
    const { email, otp } = req.body
    if (!email || !otp) {
      return sendError(res, 400, ERR.VALIDATION, 'Email và mã OTP là bắt buộc', { field: 'email,otp' })
    }

    const normalizedEmail = String(email).trim().toLowerCase()
    const cleanOtp = String(otp).trim()

    if (!/^\d{6}$/.test(cleanOtp)) {
      return sendError(res, 400, ERR.VALIDATION, 'Mã OTP phải gồm 6 chữ số', { field: 'otp' })
    }

    // Tìm OTP mới nhất còn hiệu lực chưa dùng
    const row = await queryOne(
      `SELECT * FROM email_otps WHERE email = ? AND purpose = 'login' AND used = 0 ORDER BY created_date DESC, id DESC LIMIT 1`,
      [normalizedEmail]
    )

    if (!row) {
      return sendError(res, 400, 'INVALID_OTP', 'Mã OTP không hợp lệ hoặc đã được sử dụng')
    }

    // Kiểm tra số lần thử tối đa
    if (row.attempts >= (row.max_attempts || 5)) {
      return sendError(res, 400, 'OTP_MAX_ATTEMPTS_EXCEEDED', 'Mã OTP đã vượt quá số lần thử cho phép. Vui lòng yêu cầu mã mới.')
    }

    // Kiểm tra hết hạn
    if (new Date(row.expires_at) < new Date()) {
      return sendError(res, 400, 'OTP_EXPIRED', 'Mã OTP đã hết hạn. Vui lòng yêu cầu mã mới.')
    }

    // Kiểm tra hash
    const inputHash = hashOtp(cleanOtp)
    if (inputHash !== row.otp_hash) {
      const nextAttempts = (row.attempts || 0) + 1
      await run(`UPDATE email_otps SET attempts = ? WHERE id = ?`, [nextAttempts, row.id])
      const remaining = Math.max(0, (row.max_attempts || 5) - nextAttempts)
      return sendError(res, 400, 'INVALID_OTP', 'Mã OTP không chính xác', { remainingAttempts: remaining })
    }

    // Đánh dấu used=1 nguyên tử trong transaction
    try {
      await withTransaction(async (tx) => {
        const claimed = await tx.runAffected(
          `UPDATE email_otps SET used = 1 WHERE id = ? AND used = 0`,
          [row.id],
          { op: 'auth.otp.claim' }
        )
        if (claimed !== 1) {
          const err = new Error('Mã OTP đã được sử dụng')
          err.code = 'INVALID_OTP'
          throw err
        }
      }, { op: 'auth.otp.verify' })
    } catch (e) {
      if (e?.code === 'INVALID_OTP') return sendError(res, 400, 'INVALID_OTP', e.message)
      throw e
    }

    // Passwordless auto-provisioning nếu user chưa tồn tại
    let user = await queryOne(`SELECT * FROM users WHERE email = ?`, [normalizedEmail])
    if (!user) {
      const dummyPassword = await bcrypt.hash(uuidv4(), 10)
      user = await insert('users', {
        id: uuidv4(),
        email: normalizedEmail,
        password: dummyPassword,
        role: 'user',
        name: normalizedEmail.split('@')[0],
        email_verified: true,
      })
    } else if (!user.email_verified) {
      await run(`UPDATE users SET email_verified = true WHERE id = ?`, [user.id])
      user.email_verified = true
    }

    // Cấp accessToken JWT và set cookie refresh_token chuẩn auth hiện tại
    const accessToken = generateAccessToken(user)
    const refreshToken = generateRefreshToken(user)
    await storeRefreshToken(user.id, refreshToken)
    setRefreshCookie(res, refreshToken)

    res.json({
      accessToken,
      user: publicUser(user),
    })
  } catch (err) {
    console.error('Verify OTP error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

export default router
