import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '..', '.env') })

const storageDir = path.resolve(__dirname, '..', process.env.STORAGE_DIR || './storage')

export const DEV_ACCESS_SECRET = 'video-ai-dev-access-secret'
export const DEV_REFRESH_SECRET = 'video-ai-dev-refresh-secret'
export const DEV_MASTER_KEY = 'dev-master-key'
export const DEV_DB_PASSWORD = 'VideoAI_Secure_Db_2026!'
export const MIN_SECRET_LENGTH = 32
export const MIN_DB_PASSWORD_LENGTH = 16
const PLACEHOLDER_SECRETS = new Set([
  DEV_ACCESS_SECRET,
  DEV_REFRESH_SECRET,
  DEV_MASTER_KEY,
  DEV_DB_PASSWORD,
  'change-me-in-production',
  'changeme',
  'dev',
  'password',
  'postgres',
  'admin',
  '',
])

export function isPlaceholderSecret(value) {
  return !value || PLACEHOLDER_SECRETS.has(String(value))
}

export function maskSecret(key, keepStart = 2, keepEnd = 2) {
  if (!key) return ''
  const s = String(key)
  if (s.length <= (keepStart + keepEnd + 2)) return '****'
  return s.slice(0, keepStart) + '****' + s.slice(-keepEnd)
}

export function redactSensitiveString(str) {
  if (!str) return ''
  return String(str)
    // Redact password in postgres/mysql/redis URLs: postgresql://user:password@host
    .replace(/(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@)/gi, '$1[REDACTED]$3')
    .replace(/(redis(?:s)?:\/\/(?:[^:]*:)?)([^@]+)(@)/gi, '$1[REDACTED]$3')
    // Redact Cloudinary URL: cloudinary://key:secret@cloud_name
    .replace(/(cloudinary:\/\/[^:]+:)([^@]+)(@)/gi, '$1[REDACTED]$3')
    // Redact Bearer tokens
    .replace(/(Bearer\s+)[A-Za-z0-9_\-\.]{8,}/gi, '$1[REDACTED]')
    // Redact API keys: key=..., apiKey=..., secret=...
    .replace(/((?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?)([^"'&\s]{4,})(["']?)/gi, '$1[REDACTED]$3')
}

// Pure validator (unit-testable without rebooting the process).
// Throws in production or when strictSecrets=true when secrets are missing, too short, or dev defaults.
export function assertProductionSecrets({
  nodeEnv,
  jwtAccessSecret,
  jwtRefreshSecret,
  masterKey,
  strictSecrets = (process.env.STRICT_SECRETS === 'true'),
} = {}) {
  const isStrict = nodeEnv === 'production' || strictSecrets === true || strictSecrets === 'true'
  if (!isStrict) return
  const bad = []
  for (const [name, value] of [
    ['JWT_ACCESS_SECRET', jwtAccessSecret],
    ['JWT_REFRESH_SECRET', jwtRefreshSecret],
    ['MASTER_KEY', masterKey],
  ]) {
    if (!value || isPlaceholderSecret(value) || String(value).length < MIN_SECRET_LENGTH) {
      bad.push(name)
    }
  }
  if (bad.length) {
    // Preflight thân thiện (tiếng Việt): chỉ in TÊN biến thiếu/yếu, KHÔNG BAO
    // GIỜ in giá trị secret. Giữ nguyên message throw bên dưới để unit tests
    // hiện tại (deploymentSmoke/productionRuntimeSmoke/dockerIntegration) không vỡ.
    console.error(
      `[Config] LỖI: Thiếu secret production an toàn: ${bad.join(', ')}.\n` +
      `- Copy file mẫu: copy .env.production.example .env (Windows) / cp .env.production.example .env (Linux)\n` +
      `- Sinh secret ≥${MIN_SECRET_LENGTH} ký tự (chạy 3 lần, mỗi biến 1 giá trị): node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"\n` +
      `- Điền 3 biến JWT_ACCESS_SECRET / JWT_REFRESH_SECRET / MASTER_KEY rồi chạy lại docker compose up -d --build\n` +
      `- Không commit file .env. Chi tiết xem README §6.3.`
    )
    throw new Error(
      `[Config] FATAL: missing or unsafe secrets in production: ${bad.join(', ')}. ` +
      `Set JWT_ACCESS_SECRET (>=${MIN_SECRET_LENGTH} chars), JWT_REFRESH_SECRET, MASTER_KEY via environment.`
    )
  }
}

export function assertDatabaseSecrets({
  nodeEnv = process.env.NODE_ENV,
  dbPassword,
  databaseUrl,
  strictSecrets = (process.env.STRICT_SECRETS === 'true'),
} = {}) {
  const isStrict = nodeEnv === 'production' || strictSecrets === true || strictSecrets === 'true'
  if (!isStrict) return

  // Determine what to check: if caller provided explicit databaseUrl/dbPassword, prioritize that
  const urlToCheck = databaseUrl !== undefined ? databaseUrl : (dbPassword === undefined ? process.env.DATABASE_URL : null)

  // In test environments where DATABASE_URL targets video_ai_test (and not explicitly strictSecrets=true),
  // allow test harness to run without requiring a mock production password.
  const isTestDb = urlToCheck && /\/video_ai_test(\?.*)?$/.test(urlToCheck)
  if (isTestDb && strictSecrets !== true && strictSecrets !== 'true') {
    return
  }

  // Check databaseUrl if provided / active
  if (urlToCheck) {
    let parsedPassword = ''
    try {
      const u = new URL(urlToCheck)
      parsedPassword = decodeURIComponent(u.password || '')
    } catch (_) {
      const match = urlToCheck.match(/password=([^;\s]+)/i) || urlToCheck.match(/:([^:@]+)@/)
      if (match) parsedPassword = match[1]
    }

    if (!parsedPassword || isPlaceholderSecret(parsedPassword) || parsedPassword.length < MIN_DB_PASSWORD_LENGTH) {
      console.error(
        '[Config] LỖI: Mật khẩu database trong DATABASE_URL là mật khẩu mặc định, placeholder hoặc quá ngắn (<16 ký tự) trong production/strict mode.\n' +
        '- Cấu hình DB_PASSWORD an toàn (>=16 ký tự, ngẫu nhiên) và cập nhật DATABASE_URL.\n' +
        '- Tuyệt đối không dùng mật khẩu mặc định trong production.'
      )
      throw new Error('[Config] FATAL: DATABASE_URL contains default, placeholder, or unsafe password in production.')
    }
    return
  }

  // If no databaseUrl, check dbPassword
  const passToCheck = dbPassword !== undefined ? dbPassword : process.env.DB_PASSWORD
  if (!passToCheck || isPlaceholderSecret(passToCheck) || String(passToCheck).length < MIN_DB_PASSWORD_LENGTH) {
    console.error(
      `[Config] LỖI: Thiếu hoặc mật khẩu DB_PASSWORD không an toàn trong production/strict mode (tối thiểu ${MIN_DB_PASSWORD_LENGTH} ký tự, không dùng mặc định).\n` +
      `- Cấu hình DB_PASSWORD trong .env.`
    )
    throw new Error(
      `[Config] FATAL: missing or unsafe database password in production: DB_PASSWORD. Set DB_PASSWORD (>=${MIN_DB_PASSWORD_LENGTH} chars) via environment.`
    )
  }
}

function parseOrigins(raw) {
  if (!raw) return []
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean)
}

const nodeEnv = process.env.NODE_ENV || 'development'
const jwtAccessSecret = process.env.JWT_ACCESS_SECRET || (nodeEnv === 'production' ? '' : DEV_ACCESS_SECRET)
const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || (nodeEnv === 'production' ? '' : DEV_REFRESH_SECRET)
const masterKey = process.env.MASTER_KEY || (nodeEnv === 'production' ? '' : DEV_MASTER_KEY)

// Fail-fast in production (no dev-secret boot). Never logs secret values.
assertProductionSecrets({ nodeEnv, jwtAccessSecret, jwtRefreshSecret, masterKey })

function positiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const instanceMode = String(process.env.INSTANCE_MODE || 'single').toLowerCase()
const maxConcurrentProjectsPerUser = positiveInt(process.env.MAX_CONCURRENT_PROJECTS_PER_USER, 2)

export const config = {
  port: Number(process.env.PORT || 3001),
  nodeEnv,
  jwtAccessSecret,
  jwtRefreshSecret,
  jwtAccessExpiresIn: '15m',
  jwtRefreshExpiresIn: '7d',
  masterKey,
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  youtube: {
    clientId: process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.YOUTUBE_REDIRECT_URI || '',
    frontendUrl: (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, ''),
  },
  googleTranslateScriptUrl: process.env.GOOGLE_TRANSLATE_SCRIPT_URL || '',
  storageDir,
  storage: {
    provider: process.env.STORAGE_PROVIDER || ((process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_URL) ? 'cloudinary' : 'local'),
    cloudinary: {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
      apiKey: process.env.CLOUDINARY_API_KEY || '',
      apiSecret: process.env.CLOUDINARY_API_SECRET || '',
      url: process.env.CLOUDINARY_URL || '',
      folderPrefix: process.env.CLOUDINARY_FOLDER_PREFIX || 'video_ai',
    },
    localDir: storageDir,
  },
  // Group 1: BullMQ / Redis
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
  },
  // Group 1: Concurrency limit
  maxConcurrentProjectsPerUser,
  instanceMode,
  projectLeaseSeconds: positiveInt(process.env.PROJECT_LEASE_SECONDS, 1800),
  uploadSessionTtlMinutes: positiveInt(process.env.UPLOAD_SESSION_TTL_MINUTES, 60),
  dbMaxPendingWrites: positiveInt(process.env.DB_MAX_PENDING_WRITES, 1000),
  dbSlowWriteMs: Number.isFinite(Number(process.env.DB_SLOW_WRITE_MS)) ? Number(process.env.DB_SLOW_WRITE_MS) : 1000,
  projectRetentionDays: Number(process.env.PROJECT_RETENTION_DAYS || 30),
  // Group 1: SMTP notification
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
  },
  notifyFromEmail: process.env.NOTIFY_FROM_EMAIL || '',
  // Group 4: QuotaGuard
  quotaWarningThreshold: Number(process.env.QUOTA_WARNING_THRESHOLD || 0.8),
  // Group 5: Rate limit safety margin (docs/11 §8)
  providerRateLimitSafetyMargin: Number(process.env.PROVIDER_RATE_LIMIT_SAFETY_MARGIN || 0.8),
  providerCacheEnabled: process.env.PROVIDER_CACHE_ENABLED !== 'false',
  providerCacheTtlDays: Number(process.env.PROVIDER_CACHE_TTL_DAYS || 90),
  defaultProviderMode: process.env.DEFAULT_PROVIDER_MODE || 'live', // 'live' | 'mock'
  maxUpscale: Number(process.env.MAX_UPSCALE || 2.0),
  // VoiceStudio provider config (OpenAI-compatible speech API on port 3900)
  voicestudio: {
    url: process.env.VOICESTUDIO_URL || '',
    host: process.env.VOICESTUDIO_HOST || '127.0.0.1',
    port: Number(process.env.VOICESTUDIO_PORT || 3900),
    model: process.env.VOICESTUDIO_MODEL || 'tts-1',
    voice: process.env.VOICESTUDIO_VOICE || 'default',
    apiKey: process.env.VOICESTUDIO_API_KEY || '',
    timeoutMs: Number(process.env.VOICESTUDIO_TIMEOUT_MS || 60000),
  },
  // BE-D01: ZeroTTS provider + service hardening env (docs/03,05,08,11).
  // Node client đọc trực tiếp process.env (zeroTts.js); fines này là source document
  // + validate tập trung cho Docker/CI. Invalid → fallback default, không throw lúc
  // boot (service có thể chưa chạy; fail-fast thực sự nằm ở zerotts_service.py).
  zerotts: {
    url: process.env.ZEROTTS_URL || '',
    host: process.env.ZEROTTS_HOST || '127.0.0.1',
    port: Number(process.env.ZEROTTS_PORT || 5005),
    model: process.env.ZEROTTS_MODEL || process.env.ZEROTTS_MODEL_DIR || process.env.ZEROTTS_MODEL_ID || 'zerotts',
    voice: process.env.ZEROTTS_VOICE || 'maichi',
    threads: Number(process.env.ZEROTTS_THREADS || 4),
    concurrency: Number(process.env.ZEROTTS_CONCURRENCY || 1),
    maxInflightRequests: Number(process.env.ZEROTTS_MAX_INFLIGHT_REQUESTS || 8),
    maxBodyBytes: Number(process.env.ZEROTTS_MAX_BODY_BYTES || 65536),
    maxTextChars: Number(process.env.ZEROTTS_MAX_TEXT_CHARS || 2000),
    outputRoot: process.env.ZEROTTS_OUTPUT_ROOT || '',
    timeoutMs: Number(process.env.ZEROTTS_TIMEOUT_MS || 60000),
    shutdownTimeoutMs: Number(process.env.ZEROTTS_SHUTDOWN_TIMEOUT_MS || 15000),
    // Dev orchestrator (scripts/dev.mjs) — prod ép tắt auto-start dù user set
    // true (api container không bao giờ spawn python; zerotts là container riêng).
    autoStart: process.env.ZEROTTS_AUTO_START !== 'false',
    waitForReady: String(process.env.ZEROTTS_WAIT_FOR_READY || '').toLowerCase() === 'true',
    enabled: (process.env.NODE_ENV || 'development') === 'production'
      ? false
      : String(process.env.ZEROTTS_ENABLED ?? 'true').toLowerCase() !== 'false',
    startupTimeoutMs: Number(process.env.ZEROTTS_STARTUP_TIMEOUT_MS || 90000),
    pythonBin: process.env.ZEROTTS_PYTHON_BIN || '',
  },
  // CORS allowlist: production reads CORS_ORIGINS (comma-separated, fail-closed
  // when empty). Development allows local Vite/dev origins by default.
  corsOrigins: nodeEnv === 'production'
    ? parseOrigins(process.env.CORS_ORIGINS)
    : parseOrigins(process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000,http://localhost:4173,http://127.0.0.1:5173,http://127.0.0.1:3000,http://127.0.0.1:4173'),
  // Stale heartbeat timeout (minutes) for running projects without activity.
  recoveryStaleMinutes: Number(process.env.RECOVERY_STALE_MINUTES || 10),
  // Opt-in dev echo of the raw password-reset token in the forgot-password
  // response (dev has no real SMTP). Forced off in production or strict mode regardless of env.
  authDevResetTokenInResponse:
    nodeEnv !== 'production' &&
    process.env.STRICT_SECRETS !== 'true' &&
    process.env.AUTH_DEV_RESET_TOKEN_IN_RESPONSE === 'true',
  // Refresh cookie: Secure ở production (RFC: cookie Secure chỉ gửi qua HTTPS;
  // localhost được browser miễn trừ). Ghi đè bằng COOKIE_SECURE=true|false.
  cookieSecure:
    process.env.COOKIE_SECURE !== undefined && process.env.COOKIE_SECURE !== ''
      ? String(process.env.COOKIE_SECURE).toLowerCase() === 'true'
      : nodeEnv === 'production',
  // HTTPS enforcement and proxy trust (SEC-12 & OWASP ASVS L2)
  trustProxy: process.env.TRUST_PROXY ? (isNaN(process.env.TRUST_PROXY) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY)) : 1,
  forceHttps: process.env.FORCE_HTTPS === 'true' || (nodeEnv === 'production' && process.env.DISABLE_FORCE_HTTPS !== 'true'),
}

// Boot-time observability (1 lần, không spam mỗi request; không log secret):
// - Prod CORS rỗng → fail-closed, browser cross-origin bị reject (same-origin
//   qua nginx :80 không cần CORS).
// - Prod COOKIE_SECURE=true trên HTTP LAN → browser drop cookie refresh_token.
if (nodeEnv === 'production' && config.corsOrigins.length === 0) {
  console.warn('[Config] CORS_ORIGINS rỗng ở production — mọi browser cross-origin sẽ bị "CORS: origin not allowed". Same-origin qua nginx :80 không cần CORS; gọi trực tiếp :3001/domain khác phải set CORS_ORIGINS (comma-separated).')
}
if (nodeEnv === 'production' && config.cookieSecure) {
  console.debug?.('[Config] COOKIE_SECURE=true ở production — HTTP LAN (http://<LAN-IP>) sẽ mất cookie refresh_token; dùng COOKIE_SECURE=false cho HTTP LAN nội bộ hoặc terminate TLS.')
}

// Pure CORS check (unit-testable). Non-production allows localhost defaults;
// production only allows origins explicitly listed in CORS_ORIGINS.
export function isOriginAllowed(origin, { nodeEnv: env = nodeEnv, corsOrigins = config.corsOrigins } = {}) {
  if (!origin) return true // same-origin / curl / non-browser
  if (corsOrigins.includes(origin)) return true
  if (env !== 'production') {
    try {
      const u = new URL(origin)
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true
    } catch (_) {}
  }
  return false
}

// Ensure storage sub-directories exist
for (const sub of ['uploads', 'outputs', 'tmp']) {
  const dir = path.join(config.storageDir, sub)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export default config
