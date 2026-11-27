// Deployment preparation contracts:
// - Global pipeline concurrency limit config
// - REDIS_URL / REDIS_PASSWORD / TLS parsing without leaking credentials
// - Managed PostgreSQL SSL & exception-safe RLS provisioning
// - SSE eventBus listener headroom & Cloudinary CSP allowance
// - Production docker-compose.prod.yml / Caddyfile integrity
// Run: node backend/tests/deploymentPrep.test.mjs
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

// 1. Global concurrency limit defaults (0 in test/dev, 2 in production, overridable)
{
  const { config } = await import('../src/config.js')
  assert(config.maxGlobalConcurrentPipelines === 0, `default maxGlobalConcurrentPipelines in test is 0 (got ${config.maxGlobalConcurrentPipelines})`)

  const prodCheck = spawnSync(
    process.execPath,
    ['-e', "import('./src/config.js').then(({ config }) => console.log('RESULT=' + config.maxGlobalConcurrentPipelines))"],
    {
      cwd: backendRoot,
      env: {
        ...process.env,
        DOTENV_CONFIG_QUIET: 'true',
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: strong('a'),
        JWT_REFRESH_SECRET: strong('r'),
        MASTER_KEY: strong('m'),
      },
      encoding: 'utf8',
    }
  )
  const prodVal = (String(prodCheck.stdout || '').match(/RESULT=(\d+)/) || [])[1]
  assert(prodCheck.status === 0 && prodVal === '2', `production defaults maxGlobalConcurrentPipelines=2 (got ${prodVal})`)

  const customCheck = spawnSync(
    process.execPath,
    ['-e', "import('./src/config.js').then(({ config }) => console.log('RESULT=' + config.maxGlobalConcurrentPipelines))"],
    {
      cwd: backendRoot,
      env: { ...process.env, DOTENV_CONFIG_QUIET: 'true', NODE_ENV: 'test', MAX_GLOBAL_CONCURRENT_PIPELINES: '4' },
      encoding: 'utf8',
    }
  )
  const customVal = (String(customCheck.stdout || '').match(/RESULT=(\d+)/) || [])[1]
  assert(customCheck.status === 0 && customVal === '4', `explicit MAX_GLOBAL_CONCURRENT_PIPELINES=4 respected (got ${customVal})`)
}

// 2. Redis URL + password + TLS parsing without leaking credentials
{
  const { buildRedisConnectionInfo } = await import('../src/queue/connection.js')
  const tlsInfo = buildRedisConnectionInfo({ url: 'rediss://default:supersecret@cache.example.com:6380' })
  assert(tlsInfo.endpoint === 'cache.example.com:6380', `endpoint strips credentials (got ${tlsInfo.endpoint})`)
  assert(!tlsInfo.endpoint.includes('supersecret'), 'endpoint never exposes password')
  assert(tlsInfo.options.host === 'cache.example.com' && tlsInfo.options.port === 6380, 'parses host and port from REDIS_URL')
  assert(tlsInfo.options.username === 'default' && tlsInfo.options.password === 'supersecret', 'parses auth from REDIS_URL')
  assert(Boolean(tlsInfo.options.tls), 'enables TLS for rediss://')

  const localPass = buildRedisConnectionInfo({ host: 'redis', port: 6379, password: 'pw123', tls: false })
  assert(localPass.options.host === 'redis' && localPass.options.password === 'pw123', 'supports REDIS_PASSWORD with host/port')
  assert(!localPass.options.tls, 'does not enable TLS when tls=false')
}

// 3. Managed PostgreSQL SSL detection & exception-safe RLS
{
  const r = spawnSync(
    process.execPath,
    ['-e', "import('./src/db.js').then(({ getDatabasePoolConfig }) => console.log('JSON=' + JSON.stringify(getDatabasePoolConfig())))"],
    {
      cwd: backendRoot,
      env: {
        ...process.env,
        DOTENV_CONFIG_QUIET: 'true',
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:strong_password_123456@ep-cool.neon.tech/video_ai?sslmode=require',
      },
      encoding: 'utf8',
    }
  )
  const jsonLine = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('JSON=')) || 'JSON={}'
  const parsed = JSON.parse(jsonLine.slice(5))
  assert(Boolean(parsed.ssl), 'getDatabasePoolConfig auto-enables ssl for ?sslmode=require')

  const rlsSql = fs.readFileSync(path.join(backendRoot, 'src', 'db', 'rlsPolicies.sql'), 'utf8')
  assert(rlsSql.includes('EXCEPTION WHEN insufficient_privilege'), 'rlsPolicies.sql gracefully skips role creation without CREATEROLE privilege')
}

// 4. EventBus headroom & CSP Cloudinary support
{
  const eventBus = (await import('../src/pipeline/eventBus.js')).default
  assert(eventBus.getMaxListeners() >= 500, `eventBus maxListeners >= 500 (got ${eventBus.getMaxListeners()})`)

  const { DEFAULT_CSP_DIRECTIVES } = await import('../src/middleware/securityHeaders.js')
  assert(DEFAULT_CSP_DIRECTIVES['img-src'].includes('https://res.cloudinary.com'), 'CSP img-src allows Cloudinary')
  assert(DEFAULT_CSP_DIRECTIVES['media-src'].includes('https://res.cloudinary.com'), 'CSP media-src allows Cloudinary')
  assert(DEFAULT_CSP_DIRECTIVES['connect-src'].includes('https://res.cloudinary.com'), 'CSP connect-src allows Cloudinary')
  assert(DEFAULT_CSP_DIRECTIVES['script-src'].includes('https://challenges.cloudflare.com'), 'CSP script-src allows Cloudflare Turnstile')
  assert(DEFAULT_CSP_DIRECTIVES['frame-src'].includes('https://challenges.cloudflare.com'), 'CSP frame-src allows Cloudflare Turnstile')

  const authSrc = fs.readFileSync(path.join(backendRoot, 'src', 'routes', 'v1', 'auth.js'), 'utf8')
  assert(authSrc.includes('botProtection('), 'auth.js wires botProtection middleware')
}

// 5. Production Compose & Reverse Proxy files exist and obey security/concurrency fences
{
  const prodCompose = fs.readFileSync(path.join(repoRoot, 'docker-compose.prod.yml'), 'utf8')
  assert(prodCompose.includes('MAX_GLOBAL_CONCURRENT_PIPELINES'), 'docker-compose.prod.yml configures MAX_GLOBAL_CONCURRENT_PIPELINES')
  assert(prodCompose.includes('X-Forwarded-Proto: https'), 'docker-compose.prod.yml api healthcheck sends X-Forwarded-Proto: https')
  assert(prodCompose.includes('max-size: "10m"'), 'docker-compose.prod.yml configures log rotation')
  assert(!prodCompose.includes('voicestudio'), 'docker-compose.prod.yml omits heavy voicestudio container')
  assert(!prodCompose.includes('6379:6379') && !prodCompose.includes('5432:5432'), 'docker-compose.prod.yml keeps Postgres & Redis internal')
  assert(prodCompose.includes('--maxmemory-policy') && prodCompose.includes('noeviction'), 'docker-compose.prod.yml configures Redis maxmemory noeviction')
  assert(!prodCompose.includes('noreply@asf.local'), 'docker-compose.prod.yml removes invalid noreply@asf.local fallback')
  for (const envVar of [
    'GEMINI_MODEL',
    'GEMINI_VISION_MODEL',
    'GEMINI_RPM',
    'GEMINI_MAX_RETRIES',
    'EDGE_TTS_VOICE',
    'GOOGLE_TRANSLATE_SCRIPT_URL',
    'CLOUDINARY_FOLDER_PREFIX',
    'STORAGE_DIR',
    'QUOTA_WARNING_THRESHOLD',
    'FFMPEG_CONCURRENCY',
  ]) {
    assert(prodCompose.includes(envVar), `docker-compose.prod.yml propagates ${envVar}`)
  }
  assert(fs.existsSync(path.join(repoRoot, 'docker', 'Caddyfile')), 'docker/Caddyfile exists')
  assert(fs.existsSync(path.join(repoRoot, 'docker', 'caddy.Dockerfile')), 'docker/caddy.Dockerfile exists')

  const caddyfile = fs.readFileSync(path.join(repoRoot, 'docker', 'Caddyfile'), 'utf8')
  assert(caddyfile.includes('no-cache'), 'docker/Caddyfile sets Cache-Control no-cache on SPA HTML')
  assert(caddyfile.includes('immutable'), 'docker/Caddyfile keeps immutable cache on /assets/*')
  assert(caddyfile.includes('/healthz'), 'docker/Caddyfile exposes /healthz')
  assert(caddyfile.includes('X-Content-Type-Options'), 'docker/Caddyfile sets security headers')
  assert(caddyfile.includes('max_size 1050MB'), 'docker/Caddyfile tightens request_body max_size to 1050MB')

  const apiDockerfile = fs.readFileSync(path.join(repoRoot, 'docker', 'api.Dockerfile'), 'utf8')
  assert(apiDockerfile.includes('fontconfig') && apiDockerfile.includes('ttf-dejavu'), 'docker/api.Dockerfile installs fontconfig and Unicode fonts for subtitle burn-in')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
