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
export const MIN_SECRET_LENGTH = 32
const PLACEHOLDER_SECRETS = new Set([
  DEV_ACCESS_SECRET,
  DEV_REFRESH_SECRET,
  DEV_MASTER_KEY,
  'change-me-in-production',
  'changeme',
  'dev',
  '',
])

export function isPlaceholderSecret(value) {
  return !value || PLACEHOLDER_SECRETS.has(String(value))
}

// Pure validator (unit-testable without rebooting the process).
// Throws in production when secrets are missing, too short, or dev defaults.
export function assertProductionSecrets({ nodeEnv, jwtAccessSecret, jwtRefreshSecret, masterKey } = {}) {
  if (nodeEnv !== 'production') return
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
    throw new Error(
      `[Config] FATAL: missing or unsafe secrets in production: ${bad.join(', ')}. ` +
      `Set JWT_ACCESS_SECRET (>=${MIN_SECRET_LENGTH} chars), JWT_REFRESH_SECRET, MASTER_KEY via environment.`
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
  googleTranslateScriptUrl: process.env.GOOGLE_TRANSLATE_SCRIPT_URL || '',
  storageDir,
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
  // CORS allowlist: production reads CORS_ORIGINS (comma-separated, fail-closed
  // when empty). Development allows local Vite/dev origins by default.
  corsOrigins: nodeEnv === 'production'
    ? parseOrigins(process.env.CORS_ORIGINS)
    : parseOrigins(process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000,http://localhost:4173'),
  // Stale heartbeat timeout (minutes) for running projects without activity.
  recoveryStaleMinutes: Number(process.env.RECOVERY_STALE_MINUTES || 10),
  // Opt-in dev echo of the raw password-reset token in the forgot-password
  // response (dev has no real SMTP). Forced off in production regardless of env.
  authDevResetTokenInResponse:
    nodeEnv !== 'production' && process.env.AUTH_DEV_RESET_TOKEN_IN_RESPONSE === 'true',
}

// Pure CORS check (unit-testable). Non-production allows localhost defaults;
// production only allows origins explicitly listed in CORS_ORIGINS.
export function isOriginAllowed(origin, { nodeEnv: env = nodeEnv, corsOrigins = config.corsOrigins } = {}) {
  if (!origin) return true // same-origin / curl / non-browser
  return corsOrigins.includes(origin)
}

if (config.instanceMode !== 'single') {
  throw new Error(`[Config] sql.js requires INSTANCE_MODE=single (got ${config.instanceMode})`)
}

// Ensure storage sub-directories exist
for (const sub of ['uploads', 'outputs', 'tmp']) {
  const dir = path.join(config.storageDir, sub)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export default config
