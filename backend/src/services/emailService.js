import crypto from 'node:crypto'
import nodemailer from 'nodemailer'
import { config } from '../config.js'

export const OTP_TTL_SECONDS = 300 // 5 minutes
export const OTP_PURPOSE_LOGIN = 'login'
export const OTP_MAX_ATTEMPTS = 5

let transporter = null

export function getEmailTransporter() {
  if (transporter) return transporter
  if (!config.smtp?.host) return null
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port || 587,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? {
      user: config.smtp.user,
      pass: config.smtp.password,
    } : undefined,
  })
  return transporter
}

export function resetEmailTransporterForTests() {
  transporter = null
}

/**
 * Sinh mã 6 số ngẫu nhiên an toàn bằng crypto.randomInt
 */
export function generateNumericOtp(digits = 6) {
  const min = 10 ** (digits - 1)
  const max = 10 ** digits
  return String(crypto.randomInt(min, max))
}

/**
 * Hash OTP bằng sha256 trước khi lưu DB
 */
export function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp).trim()).digest('hex')
}

/**
 * Template HTML email OTP rõ ràng, thẩm mỹ
 */
export function renderOtpEmailHtml({ otp, purpose = 'login', ttlMinutes = 5 }) {
  const actionText = purpose === 'login' ? 'đăng nhập tài khoản' : 'xác thực tài khoản'
  return `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mã xác thực OTP</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f8; margin: 0; padding: 24px; color: #1e293b;">
  <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
    <div style="text-align: center; margin-bottom: 24px;">
      <h1 style="color: #0f172a; margin: 0; font-size: 22px; font-weight: 700;">Video AI</h1>
      <p style="color: #64748b; font-size: 14px; margin-top: 4px;">Hệ thống tạo video & lồng tiếng thông minh</p>
    </div>
    <div style="border-top: 1px solid #f1f5f9; padding-top: 20px;">
      <h2 style="color: #1e293b; font-size: 18px; font-weight: 600; margin-top: 0;">Mã xác thực ${actionText}</h2>
      <p style="color: #475569; font-size: 14px; line-height: 1.6;">
        Xin chào,<br>
        Bạn vừa yêu cầu mã xác thực OTP để ${actionText} trên hệ thống Video AI. Vui lòng sử dụng mã 6 chữ số dưới đây:
      </p>
      <div style="text-align: center; margin: 28px 0;">
        <span style="display: inline-block; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #2563eb; background-color: #eff6ff; padding: 14px 28px; border-radius: 8px; border: 2px dashed #93c5fd;">
          ${otp}
        </span>
      </div>
      <p style="color: #64748b; font-size: 13px; line-height: 1.6;">
        ⏱️ Mã này có hiệu lực trong vòng <strong>${ttlMinutes} phút</strong>.<br>
        🔒 Vì lý do bảo mật, vui lòng <strong>tuyệt đối không chia sẻ mã này</strong> cho bất kỳ ai.
      </p>
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
      <p style="color: #94a3b8; font-size: 12px; line-height: 1.5; margin-bottom: 0;">
        Nếu bạn không thực hiện yêu cầu này, bạn có thể an tâm bỏ qua email này. Tài khoản của bạn vẫn được bảo vệ an toàn.
      </p>
    </div>
  </div>
</body>
</html>
  `.trim()
}

/**
 * Gửi email OTP tới người dùng. Hỗ trợ SMTP hoặc log ra console trong môi trường DEV/TEST.
 */
export async function sendOtpEmail({ email, otp, purpose = 'login' }) {
  const isDevOrTest = config.nodeEnv !== 'production'
  const allowDevOtp = isDevOrTest || process.env.DEV_OTP_EXPOSE === 'true' || config.authDevResetTokenInResponse

  if (isDevOrTest) {
    console.log(`[EmailService] DEV/TEST OTP for ${email}: ${otp}`)
  }

  const transport = getEmailTransporter()
  let sent = false

  if (transport) {
    try {
      await transport.sendMail({
        from: config.notifyFromEmail || 'noreply@videoai.local',
        to: email,
        subject: `[Video AI] Mã xác thực đăng nhập: ${otp}`,
        html: renderOtpEmailHtml({ otp, purpose, ttlMinutes: Math.round(OTP_TTL_SECONDS / 60) }),
        text: `Mã OTP xác thực đăng nhập Video AI của bạn là: ${otp}. Mã có hiệu lực trong 5 phút. Vui lòng không chia sẻ mã này cho bất kỳ ai.`,
      })
      sent = true
    } catch (err) {
      console.error('[EmailService] Gửi email qua SMTP thất bại:', err.message)
      if (!isDevOrTest) throw err
    }
  } else {
    console.log(`[EmailService] SMTP not configured. OTP logged to console for ${email}.`)
  }

  return {
    sent,
    devOtp: allowDevOtp ? otp : undefined,
  }
}

export default {
  OTP_TTL_SECONDS,
  OTP_PURPOSE_LOGIN,
  OTP_MAX_ATTEMPTS,
  generateNumericOtp,
  hashOtp,
  renderOtpEmailHtml,
  sendOtpEmail,
  getEmailTransporter,
  resetEmailTransporterForTests,
}
