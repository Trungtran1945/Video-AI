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
import {
  verifyGoogleIdToken,
  __setGoogleOAuthClientForTest,
  __resetGoogleOAuthClientForTest,
} from '../../services/googleAuthService.js'
import { validateBody } from '../../middleware/validate.js'
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from '../../validation/schemas.js'
import {
  REFRESH_COOKIE,
  getRefreshCookieOptions,
  getClearRefreshCookieOptions,
} from '../../lib/cookieOptions.js'
import {
  hashPassword,
  comparePassword,
  validatePasswordPolicy,
  needsRehash,
  DUMMY_BCRYPT_HASH,
} from '../../lib/password.js'
import { resetAllRateLimits, getClientIp } from '../../middleware/rateLimiter.js'
import { botProtection } from '../../middleware/botProtection.js'
import { canonicalizeEmail } from '../../lib/emailCanonical.js'
import { sanitizeUserDto } from '../../lib/responseSanitizer.js'
import { sensitiveNoCache } from '../../middleware/securityHeaders.js'

const router = Router()
router.use(sensitiveNoCache)

// In-memory tracker for atomic refresh rotation grace window (prevents concurrent tab races from invalidating winner session)
const recentRotations = new Map()

function publicUser(u) {
  // users.credits is a legacy column — no longer exposed (hệ Xu đã bỏ, docs/00 §2.2)
  return sanitizeUserDto(u)
}

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

function setRefreshCookie(res, token, overrides = {}) {
  res.cookie(REFRESH_COOKIE, token, getRefreshCookieOptions(overrides))
}

function clearRefreshCookie(res, overrides = {}) {
  res.clearCookie(REFRESH_COOKIE, getClearRefreshCookieOptions(overrides))
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
const registerOtpVerifyHitsByIp = new Map()
const otpVerifyHitsByIp = new Map()
const googleHitsByIp = new Map()

function pruneAuthInMemoryMaps(now = Date.now()) {
  const MAX_AGE_MS = 60 * 60 * 1000
  for (const [k, v] of recentRotations.entries()) {
    if (!v || now - v.rotatedAt > 10_000) recentRotations.delete(k)
  }
  for (const lastSentMap of [otpLastSentByEmail, registerOtpLastSentByEmail]) {
    for (const [k, ts] of lastSentMap.entries()) {
      if (now - ts > MAX_AGE_MS) lastSentMap.delete(k)
    }
  }
  for (const hitMap of [
    forgotHitsByIp,
    forgotHitsByEmail,
    otpHitsByEmail,
    otpHitsByIp,
    loginFailHitsByEmail,
    loginFailHitsByIp,
    registerHitsByIp,
    registerOtpHitsByEmail,
    registerOtpHitsByIp,
    registerOtpVerifyHitsByIp,
    otpVerifyHitsByIp,
    googleHitsByIp,
  ]) {
    for (const [k, list] of hitMap.entries()) {
      const fresh = Array.isArray(list) ? list.filter((t) => now - t < MAX_AGE_MS) : []
      if (fresh.length === 0) hitMap.delete(k)
      else if (fresh.length !== list.length) hitMap.set(k, fresh)
    }
  }
}

const authMapPruneTimer = setInterval(() => {
  try { pruneAuthInMemoryMaps() } catch (_) {}
}, 10 * 60 * 1000)
if (typeof authMapPruneTimer.unref === 'function') authMapPruneTimer.unref()

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
  registerOtpVerifyHitsByIp.clear()
  otpVerifyHitsByIp.clear()
  googleHitsByIp.clear()
  resetAllRateLimits()
}
export const __resetForgotRateLimitForTests = __resetAuthRateLimitsForTests
export const __resetOtpRateLimitForTests = __resetAuthRateLimitsForTests

export function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

export {
  verifyGoogleIdToken,
  __setGoogleOAuthClientForTest,
  __resetGoogleOAuthClientForTest,
}
export const verifyGoogleToken = verifyGoogleIdToken

// POST /api/v1/auth/register
router.post('/register', botProtection({ action: 'register' }), validateBody(registerSchema), async (req, res) => {
  try {
    const ip = getClientIp(req)
    const ipWait = hitRateLimit(registerHitsByIp, String(ip), 10, 15 * 60 * 1000)
    if (ipWait) {
      return sendError(res, 429, 'RATE_LIMITED', 'Quá nhiều yêu cầu đăng ký từ địa chỉ IP này. Vui lòng thử lại sau.', { retryAfterSec: ipWait })
    }

    const { email, password, name, otp } = req.body
    if (!email || !password) {
      return sendError(res, 400, ERR.VALIDATION, 'Email and password are required', { field: 'email,password' })
    }
    const normalizedEmail = canonicalizeEmail(email)
    const existing = await queryOne(`SELECT id FROM users WHERE email = ?`, [normalizedEmail])
    if (existing) {
      return sendError(res, 409, 'EMAIL_EXISTS', 'Email already registered', { field: 'email' })
    }

    const requireOtp = process.env.REQUIRE_REGISTRATION_OTP === 'true'
    if (requireOtp && !otp) {
      return sendError(res, 400, 'OTP_REQUIRED', 'Mã xác thực OTP là bắt buộc để hoàn tất đăng ký.', { field: 'otp' })
    }

    let isEmailVerified = false
    if (otp) {
      const cleanOtp = String(otp).trim()
      const otpRow = await queryOne(
        `SELECT * FROM email_otps WHERE email = ? AND purpose = 'register' AND used = 0 ORDER BY created_date DESC, id DESC LIMIT 1`,
        [normalizedEmail]
      )
      if (!otpRow) {
        if (requireOtp) {
          return sendError(res, 400, 'INVALID_OTP', 'Mã xác thực OTP không hợp lệ hoặc đã hết hạn.', { field: 'otp' })
        }
      } else if ((otpRow.attempts || 0) >= (otpRow.max_attempts || 5)) {
        if (requireOtp) {
          return sendError(res, 400, 'OTP_MAX_ATTEMPTS_EXCEEDED', 'Mã OTP đã vượt quá số lần thử cho phép. Vui lòng yêu cầu mã mới.', { field: 'otp' })
        }
      } else if (new Date(otpRow.expires_at) < new Date()) {
        if (requireOtp) {
          return sendError(res, 400, 'OTP_EXPIRED', 'Mã xác thực OTP không hợp lệ hoặc đã hết hạn.', { field: 'otp' })
        }
      } else if (hashOtp(cleanOtp) === otpRow.otp_hash) {
        await run(`UPDATE email_otps SET used = 1 WHERE id = ? AND used = 0`, [otpRow.id])
        isEmailVerified = true
      } else {
        const nextAttempts = (otpRow.attempts || 0) + 1
        await run(`UPDATE email_otps SET attempts = ? WHERE id = ?`, [nextAttempts, otpRow.id])
        if (requireOtp) {
          const remaining = Math.max(0, (otpRow.max_attempts || 5) - nextAttempts)
          return sendError(res, 400, 'INVALID_OTP', 'Mã xác thực OTP không hợp lệ hoặc đã hết hạn.', { field: 'otp', remainingAttempts: remaining })
        }
      }
    }

    const pwCheck = validatePasswordPolicy(password)
    if (!pwCheck.valid) {
      return sendError(res, 400, 'INVALID_PASSWORD', pwCheck.message, { field: 'password' })
    }
    const hashed = await hashPassword(password, 10)
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
    if (err?.code === 'INVALID_PASSWORD') {
      return sendError(res, 400, 'INVALID_PASSWORD', err.message, { field: 'password' })
    }
    console.error('Register error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/auth/register/send-otp
router.post('/register/send-otp', botProtection({ action: 'register_send_otp' }), async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !isValidEmail(email)) {
      return sendError(res, 400, ERR.VALIDATION, 'Email không hợp lệ hoặc bị thiếu', { field: 'email' })
    }
    const pwCheck = validatePasswordPolicy(password)
    if (!pwCheck.valid) {
      return sendError(res, 400, ERR.VALIDATION, pwCheck.message, { field: 'password' })
    }

    const normalizedEmail = canonicalizeEmail(email)
    const ip = getClientIp(req)
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

    const { sent, devOtp } = await sendOtpEmail({ email: normalizedEmail, otp, purpose: 'register' })
    if (!sent && devOtp === undefined) {
      await run(`UPDATE email_otps SET used = 1 WHERE id = ?`, [otpId]).catch(() => {})
      return sendError(res, 503, 'SMTP_NOT_CONFIGURED', 'Hệ thống gửi email OTP chưa được cấu hình. Vui lòng liên hệ quản trị viên.')
    }

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
    const ip = getClientIp(req)
    const ipWait = hitRateLimit(registerOtpVerifyHitsByIp, String(ip), 20, 15 * 60 * 1000)
    if (ipWait) {
      return sendError(res, 429, 'RATE_LIMITED', 'Quá nhiều lần xác thực OTP từ IP này. Vui lòng thử lại sau.', { retryAfterSec: ipWait })
    }

    const { email, otp, password, name } = req.body
    if (!email || !otp || !password) {
      return sendError(res, 400, ERR.VALIDATION, 'Email, mật khẩu và mã OTP là bắt buộc', { field: 'email,otp,password' })
    }

    const normalizedEmail = canonicalizeEmail(email)
    const cleanOtp = String(otp).trim()

    if (!isValidEmail(normalizedEmail)) {
      return sendError(res, 400, ERR.VALIDATION, 'Email không hợp lệ', { field: 'email' })
    }
    if (!/^\d{6}$/.test(cleanOtp)) {
      return sendError(res, 400, ERR.VALIDATION, 'Mã OTP phải gồm 6 chữ số', { field: 'otp' })
    }
    const pwCheck = validatePasswordPolicy(password)
    if (!pwCheck.valid) {
      return sendError(res, 400, 'INVALID_PASSWORD', pwCheck.message, { field: 'password' })
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

    const hashed = await hashPassword(password, 10)
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
    if (err?.code === 'INVALID_PASSWORD') {
      return sendError(res, 400, 'INVALID_PASSWORD', err.message, { field: 'password' })
    }
    console.error('Verify registration OTP error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/auth/login
router.post('/login', validateBody(loginSchema), async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return sendError(res, 400, ERR.VALIDATION, 'Email and password are required', { field: 'email,password' })
    }

    const normalizedEmail = canonicalizeEmail(email)
    const ip = getClientIp(req)
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
    // SEC-03: Mitigate login timing attacks / user enumeration by running bcrypt compare even on unknown user
    const passwordMatch = user
      ? await comparePassword(password, user.password)
      : await comparePassword(password, DUMMY_BCRYPT_HASH)

    if (!user || !passwordMatch) {
      recordRateLimitHit(loginFailHitsByIp, String(ip), 15 * 60 * 1000, now)
      recordRateLimitHit(loginFailHitsByEmail, normalizedEmail, 15 * 60 * 1000, now)
      return sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password')
    }

    loginFailHitsByEmail.delete(normalizedEmail)

    // Transparently upgrade / rehash if the stored hash used weaker cost factor
    if (needsRehash(user.password, 10)) {
      try {
        const upgraded = await hashPassword(password, 10)
        await run('UPDATE users SET password = ? WHERE id = ?', [upgraded, user.id])
      } catch (_) {}
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

// POST /api/v1/auth/google
router.post('/google', async (req, res) => {
  try {
    const rawToken = req.body && typeof req.body === 'object'
      ? (req.body.credential || req.body.idToken || req.body.token)
      : (typeof req.body === 'string' ? req.body : null)

    if (!rawToken || typeof rawToken !== 'string' || !rawToken.trim()) {
      return sendError(res, 400, ERR.VALIDATION, 'Google ID Token is required', { field: 'credential' })
    }

    const ip = getClientIp(req)
    const ipWait = hitRateLimit(googleHitsByIp, String(ip), 10, 15 * 60 * 1000)
    if (ipWait) {
      return sendError(res, 429, 'RATE_LIMITED', 'Quá nhiều yêu cầu đăng nhập Google từ IP này. Vui lòng thử lại sau.', { retryAfterSec: ipWait })
    }

    const verified = await verifyGoogleIdToken(rawToken)
    if (!verified || !verified.email || !verified.sub) {
      return sendError(res, 401, 'INVALID_GOOGLE_TOKEN', 'Google token không hợp lệ hoặc đã hết hạn')
    }

    const { email, name, sub: googleId, avatar } = verified

    // 1. Find user by Google subject ID (sub)
    let user = await queryOne(`SELECT * FROM users WHERE google_id = ?`, [googleId])

    if (user) {
      // User found by Google subject ID -> login
      await run(
        `UPDATE users SET avatar = COALESCE(avatar, ?), email_verified = true WHERE id = ?`,
        [avatar, user.id]
      )
      user = await queryOne(`SELECT * FROM users WHERE id = ?`, [user.id])
    } else {
      // 2. Not found by google_id: check if account with this verified email exists
      const existingUser = await queryOne(`SELECT * FROM users WHERE email = ?`, [email])
      if (existingUser) {
        // Prevent account collision/takeover if existing account is already linked to another Google ID
        if (existingUser.google_id && existingUser.google_id !== googleId) {
          return sendError(
            res,
            409,
            'GOOGLE_ACCOUNT_CONFLICT',
            'Tài khoản email này đã được liên kết với một tài khoản Google khác.'
          )
        }
        // Link Google ID to existing account
        await run(
          `UPDATE users SET google_id = ?, avatar = COALESCE(avatar, ?), email_verified = true WHERE id = ?`,
          [googleId, avatar, existingUser.id]
        )
        user = await queryOne(`SELECT * FROM users WHERE id = ?`, [existingUser.id])
      } else {
        // 3. Neither exists: create new user with safe race-condition handling
        const dummyPassword = await bcrypt.hash(uuidv4(), 10)
        try {
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
        } catch (insertErr) {
          // If concurrent request inserted the user, re-query
          user = await queryOne(`SELECT * FROM users WHERE google_id = ? OR email = ?`, [googleId, email])
          if (!user) {
            throw insertErr
          }
        }
      }
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
      decoded = jwt.verify(token, config.jwtRefreshSecret, {
        algorithms: ['HS256'],
      })
    } catch (_) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
    }
    const user = await queryOne(`SELECT * FROM users WHERE id = ?`, [decoded.id])
    if (!user) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
    }

    const oldHash = sha256(token)
    if (user.refresh_token !== oldHash) {
      // Check if this is a concurrent request within the 2.5s rotation grace window
      const recent = recentRotations.get(user.id)
      const isRecentRace = recent && recent.oldHash === oldHash && (Date.now() - recent.rotatedAt < 2500)
      if (isRecentRace) {
        return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
      }

      // Reused / stolen token detected outside race window: invalidate session
      await clearRefreshToken(user.id)
      clearRefreshCookie(res)
      return sendError(res, 401, 'REFRESH_TOKEN_REUSED', 'Invalid or reused refresh token')
    }
    if (user.refresh_expires && new Date(user.refresh_expires) < new Date()) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Refresh token expired')
    }
    const accessToken = generateAccessToken(user)
    const newRefresh = generateRefreshToken(user)
    const rotated = await rotateRefreshToken(user.id, oldHash, newRefresh)
    if (!rotated) return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
    recentRotations.set(user.id, { oldHash, rotatedAt: Date.now() })
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
      try { userId = jwt.verify(cookieToken, config.jwtRefreshSecret, { algorithms: ['HS256'] }).id } catch (_) {}
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
router.post('/forgot-password', validateBody(forgotPasswordSchema), async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return sendError(res, 400, ERR.VALIDATION, 'Email is required', { field: 'email' })
    const ip = getClientIp(req)
    const ipWait = hitRateLimit(forgotHitsByIp, String(ip), 5, 10 * 60 * 1000)
    if (ipWait) return sendError(res, 429, 'RATE_LIMITED', 'Quá nhiều yêu cầu đặt lại mật khẩu, thử lại sau.', { retryAfterSec: ipWait })
    const normalizedEmail = canonicalizeEmail(email)
    const emailWait = hitRateLimit(forgotHitsByEmail, normalizedEmail, 3, 60 * 60 * 1000)
    if (emailWait) return sendError(res, 429, 'RATE_LIMITED', 'Quá nhiều yêu cầu đặt lại mật khẩu, thử lại sau.', { retryAfterSec: emailWait })
    const user = await queryOne(`SELECT id FROM users WHERE email = ?`, [normalizedEmail])
    const out = { message: 'Nếu email tồn tại trong hệ thống, hướng dẫn đặt lại mật khẩu đã được gửi.' }
    if (user) {
      const { sha256 } = await import('../../lib/crypto.js')
      const { config } = await import('../../config.js')
      const token = uuidv4() + uuidv4().replace(/-/g, '')
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      await insert('reset_tokens', { email: normalizedEmail, token: sha256(token), expires_at: expires, used: 0 })
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
router.post('/reset-password', validateBody(resetPasswordSchema), async (req, res) => {
  try {
    const token = req.body.token
    const newPassword = req.body.newPassword || req.body.password
    if (!token || !newPassword) {
      return sendError(res, 400, ERR.VALIDATION, 'Token and new password are required', { field: 'token,newPassword' })
    }
    const pwCheck = validatePasswordPolicy(newPassword)
    if (!pwCheck.valid) {
      return sendError(res, 400, 'INVALID_PASSWORD', pwCheck.message, { field: 'newPassword' })
    }
    const { sha256 } = await import('../../lib/crypto.js')
    const tokenHash = sha256(token)
    const hashed = await hashPassword(newPassword, 10)
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
    clearRefreshCookie(res)
    res.json({ message: 'Mật khẩu đã được cập nhật.' })
  } catch (err) {
    if (err?.code === 'INVALID_PASSWORD') {
      return sendError(res, 400, 'INVALID_PASSWORD', err.message, { field: 'newPassword' })
    }
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

    const normalizedEmail = canonicalizeEmail(email)
    const ip = getClientIp(req)
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
    const { sent, devOtp } = await sendOtpEmail({ email: normalizedEmail, otp, purpose: 'login' })
    if (!sent && devOtp === undefined) {
      await run(`UPDATE email_otps SET used = 1 WHERE id = ?`, [otpId]).catch(() => {})
      return sendError(res, 503, 'SMTP_NOT_CONFIGURED', 'Hệ thống gửi email OTP chưa được cấu hình. Vui lòng liên hệ quản trị viên.')
    }

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
    const ip = getClientIp(req)
    const ipWait = hitRateLimit(otpVerifyHitsByIp, String(ip), 20, 15 * 60 * 1000)
    if (ipWait) {
      return sendError(res, 429, 'RATE_LIMITED', 'Quá nhiều lần xác thực OTP từ IP này. Vui lòng thử lại sau.', { retryAfterSec: ipWait })
    }

    const { email, otp } = req.body
    if (!email || !otp) {
      return sendError(res, 400, ERR.VALIDATION, 'Email và mã OTP là bắt buộc', { field: 'email,otp' })
    }

    const normalizedEmail = canonicalizeEmail(email)
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
