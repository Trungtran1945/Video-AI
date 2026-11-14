// Test suite: Nâng cấp luồng Đăng ký OTP, Đăng nhập Google, Rate Limiting & Token Security
// Run: node backend/tests/authRegistrationOtpGoogle.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { once } from 'node:events'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-auth-reg-google-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'
process.env.DEV_OTP_EXPOSE = 'true'

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne, query, run } = await import('../src/db/query.js')
const { sha256 } = await import('../src/lib/crypto.js')
const authRouter = (await import('../src/routes/v1/auth.js')).default
const { __resetAuthRateLimitsForTests } = await import('../src/routes/v1/auth.js')
const { hashOtp } = await import('../src/services/emailService.js')

await initSchema()

let failures = 0
const assert = (c, m) => {
  if (c) {
    console.log('PASS:', m)
  } else {
    failures++
    console.error('FAIL:', m)
  }
}

const app = express()
app.use(express.json())
app.use('/api/v1/auth', authRouter)
const server = app.listen(0)
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}/api/v1/auth`

const post = (p, body, headers = {}) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

const get = (p, headers = {}) => fetch(`${base}${p}`, {
  headers,
})

function makeMockGoogleJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = Buffer.from('mock_signature').toString('base64url')
  return `${header}.${body}.${sig}`
}

console.log('\n--- 1. Gửi OTP Đăng ký (POST /register/send-otp) ---')
{
  __resetAuthRateLimitsForTests()
  const email = 'newuser1@example.com'
  const res = await post('/register/send-otp', { email, password: 'password123', name: 'New User 1' })
  const body = await res.json()

  assert(res.status === 200, `Gửi OTP đăng ký thành công trả về 200 (got ${res.status})`)
  assert(body.success === true, 'Response body success = true')
  assert(body.cooldownSeconds === 60, 'Response trả về cooldownSeconds = 60')
  assert(body.expiresInSeconds === 300, 'Response trả về expiresInSeconds = 300')
  assert(typeof body.devOtp === 'string' && /^\d{6}$/.test(body.devOtp), `Trả về devOtp 6 số: ${body.devOtp}`)

  const otpRecord = await queryOne('SELECT * FROM email_otps WHERE email = ? AND purpose = ?', [email, 'register'])
  assert(!!otpRecord, 'DB đã lưu record vào bảng email_otps với purpose = register')
  assert(otpRecord.used === 0, 'Record mới có used = 0')
  assert(otpRecord.attempts === 0, 'Record mới có attempts = 0')
  assert(otpRecord.max_attempts === 5, 'Record mới có max_attempts = 5')
  assert(otpRecord.otp_hash === hashOtp(body.devOtp), 'DB lưu đúng sha256 hash của mã OTP')

  // Validation
  const resNoEmail = await post('/register/send-otp', { password: 'password123' })
  assert(resNoEmail.status === 400, 'Thiếu email trả về 400')

  const resShortPass = await post('/register/send-otp', { email: 'valid@example.com', password: '123' })
  assert(resShortPass.status === 400, 'Mật khẩu < 6 ký tự trả về 400')

  // Email đã tồn tại
  await insert('users', { id: 'existing-id-1', email: 'existing@example.com', password: 'hash', role: 'user' })
  const resExisting = await post('/register/send-otp', { email: 'existing@example.com', password: 'password123' })
  assert(resExisting.status === 409, 'Email đã tồn tại trả về 409 EMAIL_EXISTS')
}

console.log('\n--- 2. Rate Limiting cho Registration OTP ---')
{
  __resetAuthRateLimitsForTests()
  const email = 'ratelimit_reg@example.com'
  const res1 = await post('/register/send-otp', { email, password: 'password123' })
  assert(res1.status === 200, 'Lần gửi đầu tiên thành công')

  // Gửi lại ngay lập tức -> bị chặn cooldown 60s
  const res2 = await post('/register/send-otp', { email, password: 'password123' })
  const body2 = await res2.json()
  assert(res2.status === 429, `Gửi lại ngay bị chặn 429 Cooldown (got ${res2.status})`)
  assert(body2.error?.code === 'RATE_LIMITED' || body2.code === 'RATE_LIMITED', 'Error code là RATE_LIMITED')
  assert((body2.error?.retryAfterSec || body2.retryAfterSec) > 0, 'Có retryAfterSec hợp lệ')
}

console.log('\n--- 3. Xác thực OTP & Hoàn tất Đăng ký (POST /register/verify-otp) ---')
{
  __resetAuthRateLimitsForTests()
  const email = 'verify_reg@example.com'
  const sendRes = await post('/register/send-otp', { email, password: 'securePassword123!', name: 'Nguyen Van A' })
  const { devOtp } = await sendRes.json()

  // Thử mã OTP sai
  const wrongRes = await post('/register/verify-otp', {
    email,
    otp: '000000',
    password: 'securePassword123!',
    name: 'Nguyen Van A',
  })
  const wrongBody = await wrongRes.json()
  assert(wrongRes.status === 400, 'Sai OTP trả về 400')
  assert(wrongBody.code === 'INVALID_OTP' || wrongBody.error?.code === 'INVALID_OTP', 'Code trả về là INVALID_OTP')

  // Xác thực mã đúng
  const verifyRes = await post('/register/verify-otp', {
    email,
    otp: devOtp,
    password: 'securePassword123!',
    name: 'Nguyen Van A',
  })
  const verifyBody = await verifyRes.json()

  assert(verifyRes.status === 200, `Xác thực OTP thành công trả về 200 (got ${verifyRes.status})`)
  assert(!!verifyBody.accessToken, 'Trả về accessToken JWT')
  assert(verifyBody.user?.email === email, 'User email khớp')
  assert(verifyBody.user?.name === 'Nguyen Van A', 'User name khớp')
  assert(verifyBody.user?.email_verified === true, 'User có email_verified = true')
  assert(verifyBody.refreshToken === undefined, 'Không để lộ refreshToken trong response body')

  // Cookie HttpOnly SameSite
  const setCookie = verifyRes.headers.get('set-cookie') || ''
  assert(setCookie.includes('refresh_token='), 'Set-Cookie có refresh_token')
  assert(setCookie.toLowerCase().includes('httponly'), 'Cookie có cờ HttpOnly')
  assert(setCookie.toLowerCase().includes('samesite=lax'), 'Cookie có cờ SameSite=lax')
  assert(setCookie.includes('Path=/api/v1/auth'), 'Cookie có Path=/api/v1/auth')

  // Kiểm tra DB
  const dbUser = await queryOne('SELECT * FROM users WHERE email = ?', [email])
  assert(!!dbUser, 'User mới đã được lưu vào DB users')
  assert(Boolean(dbUser.email_verified) === true, 'DB user có email_verified = true')

  const dbOtp = await queryOne('SELECT * FROM email_otps WHERE email = ? AND purpose = ?', [email, 'register'])
  assert(dbOtp.used === 1, 'Mã OTP đăng ký đã được đánh dấu used = 1')

  // Thử dùng lại mã OTP đã used -> bị từ chối
  const reuseRes = await post('/register/verify-otp', {
    email,
    otp: devOtp,
    password: 'securePassword123!',
  })
  assert(reuseRes.status === 400 || reuseRes.status === 409, 'Không thể tái sử dụng mã OTP đã used')
}

console.log('\n--- 4. Đăng nhập bằng Google (POST /api/v1/auth/google) ---')
{
  __resetAuthRateLimitsForTests()

  // 4a. Tạo user mới với Google Sign-In
  const googlePayload = {
    sub: 'google-uid-10001',
    email: 'googlenew@example.com',
    name: 'Google Newbie',
    picture: 'https://lh3.googleusercontent.com/avatar10001.jpg',
    email_verified: true,
  }
  const mockJwt = makeMockGoogleJwt(googlePayload)

  const res1 = await post('/google', { credential: mockJwt })
  const body1 = await res1.json()

  assert(res1.status === 200, `Đăng nhập Google lần đầu thành công trả về 200 (got ${res1.status})`)
  assert(!!body1.accessToken, 'Trả về accessToken JWT')
  assert(body1.user?.email === 'googlenew@example.com', 'User email đúng')
  assert(body1.user?.name === 'Google Newbie', 'User name đúng')
  assert(body1.user?.avatar === 'https://lh3.googleusercontent.com/avatar10001.jpg', 'User avatar đúng')
  assert(body1.user?.email_verified === true, 'User email_verified = true')

  const setCookie = res1.headers.get('set-cookie') || ''
  assert(setCookie.includes('refresh_token='), 'Google login cấp refresh_token trong cookie HttpOnly')

  const dbGoogleUser = await queryOne('SELECT * FROM users WHERE google_id = ?', ['google-uid-10001'])
  assert(!!dbGoogleUser, 'DB đã lưu google_id chính xác')

  // 4b. Đăng nhập lại với cùng Google Account (không nhân đôi bản ghi)
  const res2 = await post('/google', { credential: mockJwt })
  const body2 = await res2.json()
  assert(res2.status === 200, 'Đăng nhập Google lần 2 thành công')
  assert(body2.user?.id === dbGoogleUser.id, 'Tìm đúng ID user cũ')

  const allCount = await query('SELECT id FROM users WHERE email = ?', ['googlenew@example.com'])
  assert(allCount.length === 1, 'Không bị nhân đôi tài khoản trong DB')

  // 4c. Liên kết Google Account vào tài khoản thường đã có sẵn email
  const existingLocalEmail = 'localuser@example.com'
  await insert('users', {
    id: 'local-user-id-55',
    email: existingLocalEmail,
    password: 'hashedPassword',
    role: 'user',
    name: 'Local User',
    email_verified: false,
  })

  const linkJwt = makeMockGoogleJwt({
    sub: 'google-uid-link-999',
    email: existingLocalEmail,
    name: 'Local User Updated',
    picture: 'https://lh3.googleusercontent.com/avatar_link.jpg',
  })
  const resLink = await post('/google', { credential: linkJwt })
  const bodyLink = await resLink.json()

  assert(resLink.status === 200, 'Liên kết Google vào tài khoản thường thành công 200')
  assert(bodyLink.user?.id === 'local-user-id-55', 'Giữ đúng ID tài khoản đã có')
  const linkedUser = await queryOne('SELECT * FROM users WHERE id = ?', ['local-user-id-55'])
  assert(linkedUser.google_id === 'google-uid-link-999', 'google_id đã được cập nhật vào user')
  assert(Boolean(linkedUser.email_verified) === true, 'email_verified đã được nâng cấp thành true')

  // 4d. Token không hợp lệ
  const invalidRes = await post('/google', { credential: 'invalid.token.here' })
  assert(invalidRes.status === 401, 'Token không hợp lệ trả về 401')
}

console.log('\n--- 5. Rate Limiting cho Đăng nhập thường (POST /api/v1/auth/login) ---')
{
  __resetAuthRateLimitsForTests()
  const targetEmail = 'target_bruteforce@example.com'
  // Tạo user thử nghiệm
  const bcrypt = (await import('bcryptjs')).default
  const hashed = await bcrypt.hash('correctPassword123!', 10)
  await insert('users', {
    id: 'target-user-id',
    email: targetEmail,
    password: hashed,
    role: 'user',
    name: 'Target User',
  })

  // Thử 5 lần mật khẩu sai -> nhận 401
  for (let i = 1; i <= 5; i++) {
    const wrongRes = await post('/login', { email: targetEmail, password: 'wrongPassword' })
    assert(wrongRes.status === 401, `Lần ${i} nhập sai trả về 401 (got ${wrongRes.status})`)
  }

  // Lần thứ 6 -> bị chặn 429 Too Many Requests do quá 5 lần sai
  const blockedRes = await post('/login', { email: targetEmail, password: 'wrongPassword' })
  const blockedBody = await blockedRes.json()
  assert(blockedRes.status === 429, `Lần 6 bị chặn 429 RATE_LIMITED (got ${blockedRes.status})`)
  assert(blockedBody.code === 'RATE_LIMITED' || blockedBody.error?.code === 'RATE_LIMITED', 'Error code là RATE_LIMITED')
  assert((blockedBody.retryAfterSec || blockedBody.error?.retryAfterSec) > 0, 'Có thông tin retryAfterSec')

  // Đăng nhập đúng mật khẩu lúc đang bị rate-limit vẫn bị chặn cho đến khi hết hạn hoặc reset
  const stillBlocked = await post('/login', { email: targetEmail, password: 'correctPassword123!' })
  assert(stillBlocked.status === 429, 'Đang trong thời gian khóa, nhập đúng mật khẩu vẫn bị chặn 429')

  // Sau khi reset, đăng nhập thành công
  __resetAuthRateLimitsForTests()
  const successRes = await post('/login', { email: targetEmail, password: 'correctPassword123!' })
  assert(successRes.status === 200, 'Sau khi hết rate-limit, đăng nhập đúng mật khẩu thành công 200')
}

console.log('\n--- 6. Endpoint GET /api/v1/auth/me phản hồi đầy đủ trường mới ---')
{
  const email = 'check_me@example.com'
  const userRecord = await insert('users', {
    id: 'user-me-test',
    email,
    password: 'hashedPassword',
    role: 'user',
    name: 'Me Tester',
    email_verified: true,
    avatar: 'https://example.com/my-avatar.png',
  })
  const { generateAccessToken } = await import('../src/middleware/auth.js')
  const token = generateAccessToken(userRecord)

  const meRes = await get('/me', { authorization: `Bearer ${token}` })
  const meBody = await meRes.json()

  assert(meRes.status === 200, 'GET /me trả về 200')
  assert(meBody.email_verified === true, 'GET /me trả về email_verified = true')
  assert(meBody.avatar === 'https://example.com/my-avatar.png', 'GET /me trả về avatar URL')
  assert(meBody.credits === undefined, 'GET /me không để lộ credits (đã bỏ hệ Xu)')
}

server.close()

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertions failed`)
  process.exit(1)
} else {
  console.log('\nALL PASS: Registration OTP, Google Sign-In, Rate Limiting & Token Security validated successfully.')
  process.exit(0)
}
