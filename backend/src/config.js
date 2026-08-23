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
  storageDir,
}

// Ensure storage sub-directories exist
for (const sub of ['uploads', 'outputs', 'tmp']) {
  const dir = path.join(config.storageDir, sub)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export default config
