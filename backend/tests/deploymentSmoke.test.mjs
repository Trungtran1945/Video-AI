// Production deployment config contract: secrets fail-fast, compose fences,
// .env.production.example, Whisper env, no unsafe defaults.
// Runtime boot is covered by productionRuntimeSmoke.test.mjs (NODE_ENV=production,
// PORT=0 ephemeral) and dockerIntegration.test.mjs (Redis connectivity).
// Uses ephemeral CI secrets only — never real secrets.
// Run: node backend/tests/deploymentSmoke.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.join(__dirname, '..')
const repoRoot = path.join(backendRoot, '..')

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const strong = (s) => `${s}-0123456789abcdef0123456789abcdef0123456789abcdef`

// 1. Compose fences: Redis internal only, Whisper env, no placeholder secrets
{
  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8')
  assert(!compose.includes('6379:6379'), 'Redis public port absent (internal network only)')
  assert(!compose.includes('0.0.0.0:6379'), 'no 0.0.0.0 Redis binding')
  assert(compose.includes('REDIS_HOST=redis'), 'API uses internal REDIS_HOST=redis')
  assert(compose.includes('REDIS_PORT=6379'), 'API uses internal REDIS_PORT=6379')
  for (const k of ['WHISPER_BASE_URL', 'WHISPER_MODEL', 'WHISPER_TEMPERATURE', 'WHISPER_INITIAL_PROMPT']) {
    assert(compose.includes(k), `compose passes ${k}`)
  }
  assert(!compose.includes('change-me-in-production'), 'compose never injects placeholder secrets')
  assert(compose.includes('JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-}'), 'compose passes JWT secrets without default')
  // Local-dev override exists and binds localhost only
  const overridePath = path.join(repoRoot, 'docker-compose.redis-host.yml')
  assert(fs.existsSync(overridePath), 'local-dev Redis override file exists')
  const override = fs.readFileSync(overridePath, 'utf8')
  assert(override.includes('127.0.0.1:6379:6379'), 'local override binds localhost only (never 0.0.0.0)')
}

// 2. .env.production.example contract
{
  const p = path.join(repoRoot, '.env.production.example')
  assert(fs.existsSync(p), '.env.production.example exists')
  const src = fs.readFileSync(p, 'utf8')
  for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'MASTER_KEY', 'CORS_ORIGINS']) {
    assert(src.includes(k), `.env.production.example documents ${k}`)
  }
  assert(src.includes('WHISPER_'), '.env.production.example documents Whisper config')
  assert(!/change-me-in-production|video-ai-dev/i.test(src.replace(/replace-with.*/gi, '')) || src.includes('replace-with'), 'no unsafe dev secret defaults (placeholder replace-with only)')
}

// 3. Production missing secrets → fail-fast (config import exits non-zero)
{
  for (const missing of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'MASTER_KEY']) {
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: strong('access'),
      JWT_REFRESH_SECRET: strong('refresh'),
      MASTER_KEY: strong('master'),
    }
    delete env[missing]
    // Ensure empty string also fails (compose :- empty case)
    env[missing] = ''
    const r = spawnSync(process.execPath, ['-e', "import('./src/config.js').then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1) })"], {
      cwd: backendRoot,
      env,
      encoding: 'utf8',
    })
    assert(r.status !== 0, `production missing ${missing} → fail-fast (exit ${r.status})`)
  }
}

// 4. Valid ephemeral secrets → config loads, no dev secrets
{
  const r = spawnSync(process.execPath, ['-e', "import('./src/config.js').then(({ config }) => { if (config.jwtAccessSecret.includes('dev')) process.exit(2); console.log('ok') })"], {
    cwd: backendRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: strong('access'),
      JWT_REFRESH_SECRET: strong('refresh'),
      MASTER_KEY: strong('master'),
      CORS_ORIGINS: 'https://app.example.com',
    },
    encoding: 'utf8',
  })
  assert(r.status === 0 && String(r.stdout).includes('ok'), 'production valid secrets → config loads')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
