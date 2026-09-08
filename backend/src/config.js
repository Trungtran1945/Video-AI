import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '..', '.env') })

const storageDir = path.resolve(__dirname, '..', process.env.STORAGE_DIR || './storage')

export const config = {
  port: Number(process.env.PORT || 3001),
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || 'video-ai-dev-access-secret',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'video-ai-dev-refresh-secret',
  jwtAccessExpiresIn: '15m',
  jwtRefreshExpiresIn: '7d',
  masterKey: process.env.MASTER_KEY || 'dev-master-key',
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
  maxConcurrentProjectsPerUser: Number(process.env.MAX_CONCURRENT_PROJECTS_PER_USER || 2),
  // Group 1: Retention
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
}

// Ensure storage sub-directories exist
for (const sub of ['uploads', 'outputs', 'tmp']) {
  const dir = path.join(config.storageDir, sub)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export default config
