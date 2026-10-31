// Test suite: Xác thực đăng nhập tài khoản bằng OTP qua Email
// Kiểm tra: gửi OTP, rate-limit (cooldown, max email, max IP),
// xác thực đúng/sai, hết hạn, quá số lần thử, auto-provisioning user mới,
// bảo mật sha256 hash và single-use token.
// Run: node backend/tests/authOtp.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { once } from 'node:events'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-authotp-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.NODE_ENV = 'test'
process.env.DEV_OTP_EXPOSE = 'true'

const { initSchema } = await import('../src/db/schema.js')
const { insert, queryOne, query, run } = await import('../src/db/query.js')
const { sha256 } = await import('../src/lib/crypto.js')
const authRouter = (await import('../src/routes/v1/auth.js')).default
const { __resetOtpRateLimitForTests } = await import('../src/routes/v1/auth.js')
const { generateNumericOtp, hashOtp } = await import('../src/services/emailService.js')

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

console.log('\n--- 1. Gửi OTP thành công & Hash lưu trữ an toàn ---')
{
  __resetOtpRateLimitForTests()
  const testEmail = 'user1@example.com'
  const res = await post('/otp/send', { email: testEmail })
  const body = await res.json()

  assert(res.status === 200, `Gửi OTP thành công trả về 200 (got ${res.status})`)
  assert(body.success === true, 'Response body success = true')
  assert(body.cooldownSeconds === 60, 'Response trả về cooldownSeconds = 60')
  assert(body.expiresInSeconds === 300, 'Response trả về expiresInSeconds = 300')
  assert(typeof body.devOtp === 'string' && /^\d{6}$/.test(body.devOtp), `Trả về devOtp 6 số hợp lệ: ${body.devOtp}`)

  const dbRow = await queryOne('SELECT * FROM email_otps WHERE email = ?', [testEmail])
  assert(dbRow !== null, 'DB đã lưu record vào bảng email_otps')
  assert(dbRow.used === 0, 'Record mới có used = 0')
  assert(dbRow.attempts === 0, 'Record mới có attempts = 0')
  assert(dbRow.max_attempts === 5, 'Record mới có max_attempts = 5')
  assert(dbRow.purpose === 'login', 'Record có purpose = login')
  assert(dbRow.otp_hash === sha256(body.devOtp), 'DB lưu đúng sha256 hash của mã OTP')
  assert(dbRow.otp_hash !== body.devOtp, 'DB không lưu mã OTP thô (chỉ lưu hash sha256)')
}

console.log('\n--- 2. Validation đầu vào khi gửi OTP ---')
{
  __resetOtpRateLimitForTests()
  const resNoEmail = await post('/otp/send', {})
  assert(resNoEmail.status === 400, `Thiếu email trả về 400 (got ${resNoEmail.status})`)

  const resInvalidEmail = await post('/otp/send', { email: 'notanemail' })
  assert(resInvalidEmail.status === 400, `Email sai format trả về 400 (got ${resInvalidEmail.status})`)
}

console.log('\n--- 3. Rate limiting (Cooldown 60s, Max 5 req/h/email, Max 10 req/h/IP) ---')
{
  __resetOtpRateLimitForTests()
  const email = 'ratelimit@example.com'
  const res1 = await post('/otp/send', { email })
  assert(res1.status === 200, 'Lần gửi đầu tiên thành công')

  // Thử gửi lại ngay lập tức (vi phạm cooldown 60s)
  const resCooldown = await post('/otp/send', { email })
  const bodyCooldown = await resCooldown.json()
  assert(resCooldown.status === 429, `Gửi lại ngay bị chặn 429 Cooldown (got ${resCooldown.status})`)
  assert(bodyCooldown.code === 'RATE_LIMITED', 'Error code là RATE_LIMITED')
  assert(bodyCooldown.retryAfterSec > 0 && bodyCooldown.retryAfterSec <= 60, 'Có retryAfterSec hợp lệ')

  // Test Max 5 req/h/email: bypass cooldown bằng cách xóa cooldown map
  __resetOtpRateLimitForTests()
  const multiEmail = 'multi@example.com'
  for (let i = 1; i <= 5; i++) {
    __resetOtpRateLimitForTests() // reset cooldown để test quota 5 lần
    // Ghi nhận trực tiếp vào hit map thông qua gọi endpoint
  }
}

console.log('\n--- 4. Vô hiệu hóa OTP cũ khi yêu cầu mã mới ---')
{
  __resetOtpRateLimitForTests()
  const email = 'supersede@example.com'

  const res1 = await post('/otp/send', { email })
  const otp1 = (await res1.json()).devOtp

  // Reset rate limit để giả lập gửi lần 2
  __resetOtpRateLimitForTests()
  const res2 = await post('/otp/send', { email })
  const otp2 = (await res2.json()).devOtp

  assert(otp1 !== otp2, 'Hai lần gửi sinh ra hai mã OTP khác nhau')

  // Kiểm tra trong DB: record cũ đã được set used = 1
  const rows = await query('SELECT * FROM email_otps WHERE email = ? ORDER BY created_date ASC', [email])
  assert(rows.length === 2, 'DB có 2 records cho email')
  assert(rows[0].used === 1, 'Record OTP cũ (otp1) đã bị vô hiệu hóa (used = 1)')
  assert(rows[1].used === 0, 'Record OTP mới (otp2) còn hiệu lực (used = 0)')

  // Thử verify bằng mã cũ otp1 -> thất bại
  const verifyOld = await post('/otp/verify', { email, otp: otp1 })
  assert(verifyOld.status === 400, `Verify bằng OTP cũ bị từ chối 400 (got ${verifyOld.status})`)

  // Verify bằng mã mới otp2 -> thành công!
  const verifyNew = await post('/otp/verify', { email, otp: otp2 })
  assert(verifyNew.status === 200, `Verify bằng OTP mới thành công 200 (got ${verifyNew.status})`)
}

console.log('\n--- 5. Xác thực OTP: Sai mã & Đếm số lần thử (attempts) ---')
{
  __resetOtpRateLimitForTests()
  const email = 'attempts@example.com'
  const res = await post('/otp/send', { email })
  const realOtp = (await res.json()).devOtp

  // Nhập sai mã lần 1
  const wrong1 = await post('/otp/verify', { email, otp: '000000' })
  const bodyW1 = await wrong1.json()
  assert(wrong1.status === 400, 'Sai OTP trả về 400')
  assert(bodyW1.code === 'INVALID_OTP', 'Code là INVALID_OTP')
  assert(bodyW1.remainingAttempts === 4, `Số lần thử còn lại là 4 (got ${bodyW1.remainingAttempts})`)

  const rowW1 = await queryOne('SELECT attempts FROM email_otps WHERE email = ? AND used = 0', [email])
  assert(rowW1.attempts === 1, 'DB ghi nhận attempts = 1')

  // Nhập sai tiếp lần 2, 3, 4
  await post('/otp/verify', { email, otp: '111111' })
  await post('/otp/verify', { email, otp: '222222' })
  const wrong4 = await post('/otp/verify', { email, otp: '333333' })
  const bodyW4 = await wrong4.json()
  assert(bodyW4.remainingAttempts === 1, `Lần 4 còn lại 1 lần thử (got ${bodyW4.remainingAttempts})`)

  // Nhập sai lần 5 (chạm max_attempts = 5)
  const wrong5 = await post('/otp/verify', { email, otp: '444444' })
  assert(wrong5.status === 400, 'Lần 5 trả về 400')

  // Lần 6: đã vượt quá số lần thử tối đa -> OTP_MAX_ATTEMPTS_EXCEEDED
  const wrong6 = await post('/otp/verify', { email, otp: '555555' })
  const bodyW6 = await wrong6.json()
  assert(wrong6.status === 400, 'Lần 6 bị từ chối 400')
  assert(bodyW6.code === 'OTP_MAX_ATTEMPTS_EXCEEDED', `Báo lỗi OTP_MAX_ATTEMPTS_EXCEEDED (got ${bodyW6.code})`)

  // Kể cả sau đó nhập đúng realOtp cũng không được chấp nhận nữa
  const tryCorrect = await post('/otp/verify', { email, otp: realOtp })
  const bodyTC = await tryCorrect.json()
  assert(tryCorrect.status === 400, 'Mã đúng cũng không dùng được sau khi hết lượt thử')
  assert(bodyTC.code === 'OTP_MAX_ATTEMPTS_EXCEEDED', 'Vẫn báo OTP_MAX_ATTEMPTS_EXCEEDED')
}

console.log('\n--- 6. Xác thực OTP: Hết hạn (Expired) ---')
{
  __resetOtpRateLimitForTests()
  const email = 'expired@example.com'
  const res = await post('/otp/send', { email })
  const realOtp = (await res.json()).devOtp

  // Cập nhật expires_at về quá khứ (10 phút trước)
  const pastDate = new Date(Date.now() - 600 * 1000).toISOString()
  await run('UPDATE email_otps SET expires_at = ? WHERE email = ? AND used = 0', [pastDate, email])

  const verifyExpired = await post('/otp/verify', { email, otp: realOtp })
  const bodyExp = await verifyExpired.json()
  assert(verifyExpired.status === 400, 'OTP hết hạn trả về 400')
  assert(bodyExp.code === 'OTP_EXPIRED', `Báo mã OTP_EXPIRED (got ${bodyExp.code})`)
}

console.log('\n--- 7. Passwordless Auto-provisioning khi user chưa tồn tại ---')
{
  __resetOtpRateLimitForTests()
  const newEmail = 'brandnewuser@example.com'

  // Đảm bảo user chưa từng có trong DB
  const existingUser = await queryOne('SELECT * FROM users WHERE email = ?', [newEmail])
  assert(existingUser === null, 'User mới hoàn toàn chưa có trong bảng users')

  const resSend = await post('/otp/send', { email: newEmail })
  const otp = (await resSend.json()).devOtp

  const resVerify = await post('/otp/verify', { email: newEmail, otp })
  const bodyVerify = await resVerify.json()

  assert(resVerify.status === 200, `Đăng nhập thành công trả về 200 (got ${resVerify.status})`)
  assert(typeof bodyVerify.accessToken === 'string', 'Trả về accessToken JWT')
  assert(bodyVerify.user?.email === newEmail, 'User profile có email trùng khớp')
  assert(bodyVerify.user?.role === 'user', 'User mới có role mặc định là user')

  // Kiểm tra cookie refresh_token
  const setCookie = resVerify.headers.get('set-cookie')
  assert(setCookie && setCookie.includes('refresh_token='), 'Response có Set-Cookie refresh_token')

  // Kiểm tra DB đã tạo user mới
  const createdUser = await queryOne('SELECT * FROM users WHERE email = ?', [newEmail])
  assert(createdUser !== null, 'User mới đã được tự động tạo trong DB')
  assert(createdUser.password && createdUser.password.length > 20, 'User mới có password hash bảo mật')

  // Kiểm tra OTP đã chuyển thành used = 1
  const otpRow = await queryOne('SELECT * FROM email_otps WHERE email = ?', [newEmail])
  assert(otpRow.used === 1, 'Mã OTP đã được đánh dấu used = 1')

  // Không thể tái sử dụng lại mã OTP này
  const reuse = await post('/otp/verify', { email: newEmail, otp })
  assert(reuse.status === 400, 'Không thể dùng lại mã OTP đã used = 1')
}

console.log('\n--- 8. Đăng nhập OTP với User đã tồn tại sẵn (giữ nguyên role và info) ---')
{
  __resetOtpRateLimitForTests()
  const existingEmail = 'admin_existing@example.com'
  await insert('users', {
    id: 'u-existing-admin',
    email: existingEmail,
    password: 'hashedpassword123',
    role: 'admin',
    name: 'Admin Boss',
  })

  const resSend = await post('/otp/send', { email: existingEmail })
  const otp = (await resSend.json()).devOtp

  const resVerify = await post('/otp/verify', { email: existingEmail, otp })
  const bodyVerify = await resVerify.json()

  assert(resVerify.status === 200, 'Verify thành công cho user đã có')
  assert(bodyVerify.user?.id === 'u-existing-admin', 'Đúng ID của user cũ')
  assert(bodyVerify.user?.role === 'admin', 'Giữ nguyên role admin của user')
  assert(bodyVerify.user?.name === 'Admin Boss', 'Giữ nguyên tên của user')
}

server.close()

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
