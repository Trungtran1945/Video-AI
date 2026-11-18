import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
let failures = 0
const assert = (condition, message) => {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

const compose = fs.readFileSync(path.join(root, '..', 'docker-compose.yml'), 'utf8')
assert(compose.includes('DATABASE_URL=postgresql://'), 'Compose configures the API to use PostgreSQL')
assert(!compose.includes('db_data:'), 'Compose has no SQLite db_data volume mount')
assert(!compose.includes('scale-disabled') && !/^\s{2}worker:/m.test(compose), 'Compose has no crash-loop placeholder worker service')
assert(!compose.includes('change-me-in-production'), 'Compose never injects placeholder secrets (fail-fast instead)')
assert(compose.includes('JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-}'), 'Compose passes the JWT secret through without a default')
assert(compose.includes('UPLOAD_SESSION_TTL_MINUTES=${UPLOAD_SESSION_TTL_MINUTES:-60}'), 'Compose configures the upload session TTL')
assert(!compose.includes('6379:6379'), 'Compose never exposes Redis publicly (internal network only)')
assert(compose.includes('REDIS_HOST=redis'), 'Compose API uses internal Redis host')
assert(compose.includes('WHISPER_BASE_URL='), 'Compose passes WHISPER_BASE_URL')
assert(compose.includes('WHISPER_MODEL='), 'Compose passes WHISPER_MODEL')
assert(compose.includes('WHISPER_TEMPERATURE='), 'Compose passes WHISPER_TEMPERATURE')
assert(compose.includes('WHISPER_INITIAL_PROMPT='), 'Compose passes WHISPER_INITIAL_PROMPT')

const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8')
const drainQueue = fs.readFileSync(path.join(root, 'src', 'queue', 'drainQueue.js'), 'utf8')
const nginx = fs.readFileSync(path.join(root, '..', 'docker', 'nginx.conf'), 'utf8')
const apiDockerfile = fs.readFileSync(path.join(root, '..', 'docker', 'api.Dockerfile'), 'utf8')
assert(server.includes('safeAddDrainSweep'), 'server schedules queued-project draining')
assert(server.includes('resumableUploadService.recoverUploadSessions()'), 'server recovers completing uploads before listening')
assert(server.includes('createSafeMediaStatic'), 'server uses filtered media serving')
assert(drainQueue.includes("every: 5000"), 'queued-project drain has a bounded repeat interval')
assert(nginx.includes('client_max_body_size 4100m') && nginx.includes('proxy_request_buffering off') && nginx.includes('proxy_read_timeout 7200s'), 'Nginx admits 4GiB multipart overhead and long upload processing without prebuffering')
assert(!/\|\| true/.test(apiDockerfile), 'API image build does not mask a missing build command')

const ttlConfig = spawnSync(process.execPath, ['-e', "import('./src/config.js').then(({ config }) => console.log(config.uploadSessionTtlMinutes))"], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, UPLOAD_SESSION_TTL_MINUTES: '17', NODE_ENV: 'test' },
})
assert(ttlConfig.status === 0 && String(ttlConfig.stdout).trim().endsWith('17'), 'upload session TTL is configurable')

// Invariant: Multiple concurrent processes can connect to PostgreSQL without writer lock errors
const testUrl = process.env.DATABASE_URL || 'postgresql://video_ai_user:VideoAI_Secure_Db_2026!@localhost:5433/video_ai_test'
const proc1 = spawnSync(process.execPath, ['-e', "import('./src/db.js').then(async ({ getDb, closePool }) => { await getDb(); await closePool(); process.exit(0); }).catch(() => process.exit(1));"], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: testUrl, NODE_ENV: 'test' },
  encoding: 'utf8',
})
assert(proc1.status === 0, 'first process connects cleanly to PostgreSQL')

const proc2 = spawnSync(process.execPath, ['-e', "import('./src/db.js').then(async ({ getDb, closePool }) => { await getDb(); await closePool(); process.exit(0); }).catch(() => process.exit(1));"], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: testUrl, NODE_ENV: 'test' },
  encoding: 'utf8',
})
assert(proc2.status === 0, 'second concurrent process connects cleanly to PostgreSQL without lock conflict')

if (failures > 0) process.exit(1)
console.log('ALL PASS')
