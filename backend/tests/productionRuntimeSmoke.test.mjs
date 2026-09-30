// Production runtime smoke: actual server boot with NODE_ENV=production,
// strong ephemeral secrets, ephemeral PORT=0 (no fixed port).
// Production requires Redis (server.js fail-fast). When a Docker daemon is
// available the test boots an ephemeral redis (localhost-only publish) and
// verifies /health + /ready with real connected semantics. Without Docker
// the full boot is BLOCKED and only the Redis fail-fast is asserted.
// Uses ephemeral CI secrets only — never real secrets.
// Run: node backend/tests/productionRuntimeSmoke.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
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

function dockerOk() {
  try {
    const r = spawnSync('docker', ['info'], { cwd: repoRoot, encoding: 'utf8' })
    return r.status === 0
  } catch (_) {
    return false
  }
}

function waitForRedisHealthy(timeoutMs = 60000) {
  const start = Date.now()
  return (async () => {
    for (;;) {
      try {
        const r = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.redis-host.yml', 'ps', 'redis', '--format', 'json'], { cwd: repoRoot, encoding: 'utf8' })
        const txt = String(r.stdout || '').trim()
        if (txt && (txt.includes('healthy') || txt.includes('running'))) return true
        // Fallback: exec ping
        const p = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.redis-host.yml', 'exec', '-T', 'redis', 'redis-cli', 'ping'], { cwd: repoRoot, encoding: 'utf8' })
        if (p.status === 0 && String(p.stdout).includes('PONG')) return true
      } catch (_) {}
      if (Date.now() - start > timeoutMs) return false
      await new Promise((r) => setTimeout(r, 2000))
    }
  })()
}

async function bootProdServer({ redisHost, redisPort }) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-prod-runtime-'))
  const env = {
    ...process.env,
    DB_PATH: path.join(tmpRoot, 'test.db'),
    STORAGE_DIR: path.join(tmpRoot, 'storage'),
    NODE_ENV: 'production',
    PORT: '0',
    JWT_ACCESS_SECRET: strong('access'),
    JWT_REFRESH_SECRET: strong('refresh'),
    MASTER_KEY: strong('master'),
    CORS_ORIGINS: 'https://app.example.com',
  }
  if (redisHost) env.REDIS_HOST = redisHost
  if (redisPort) env.REDIS_PORT = String(redisPort)
  const child = spawn(process.execPath, ['server.js'], { cwd: backendRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  return { child, tmpRoot }
}

const hasDocker = dockerOk()
let redisStartedByUs = false

if (hasDocker) {
  console.log('PASS: docker daemon available — starting ephemeral redis for production boot')
  const up = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.redis-host.yml', 'up', '-d', 'redis'], { cwd: repoRoot, encoding: 'utf8' })
  if (up.status !== 0) {
    console.log(`BLOCKED: could not start ephemeral redis — ${String(up.stderr).slice(0, 500)}`)
  } else {
    redisStartedByUs = true
    const healthy = await waitForRedisHealthy(60000)
    assert(healthy, 'ephemeral redis healthy before production boot')
  }
} else {
  console.log('BLOCKED: docker daemon unavailable — production full boot NOT VERIFIED (will assert Redis fail-fast only)')
}

if (hasDocker && redisStartedByUs) {
  // Full production boot with Redis → expect connected.
  const { child, tmpRoot } = await bootProdServer({ redisHost: '127.0.0.1', redisPort: 6379 })
  let out = ''
  let actualPort = 0
  child.stdout.on('data', (d) => {
    out += String(d)
    const m = out.match(/Backend running at http:\/\/localhost:(\d+)/)
    if (m) actualPort = Number(m[1])
  })
  child.stderr.on('data', (d) => { out += String(d) })
  const waitFor = async (fn, timeoutMs) => {
    const start = Date.now()
    for (;;) {
      try {
        const v = await fn()
        if (v) return v
      } catch (_) {}
      if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for boot')
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  try {
    await waitFor(() => (actualPort > 0 ? actualPort : null), 30000)
    assert(actualPort > 0 && actualPort < 65536, `production boot reports ephemeral port (got ${actualPort})`)
    assert(actualPort !== 32279, 'no fixed test port in use')

    const health = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${actualPort}/health`)
      if (!r.ok && r.status !== 503) return null
      return r.json()
    }, 30000)
    assert(health?.database?.persistenceState === 'HEALTHY', `production /health persistenceState HEALTHY (got ${health?.database?.persistenceState})`)
    assert(health?.redis === 'connected', `production /health redis connected with ephemeral redis (got ${health?.redis})`)
    assert(health?.bullmq === 'available', `production /health bullmq available (got ${health?.bullmq})`)
    assert(fs.existsSync(path.join(tmpRoot, 'test.db')) || fs.existsSync(path.join(tmpRoot, 'storage')), 'database/storage initialized on production boot')

    const readyRes = await fetch(`http://127.0.0.1:${actualPort}/ready`)
    const ready = await readyRes.json()
    assert(readyRes.status === 200 && ready?.ready === true, `production /ready 200 ready:true (got ${readyRes.status}/${ready?.ready})`)
    assert(ready?.database?.persistenceState === 'HEALTHY', `production /ready persistenceState HEALTHY (got ${ready?.database?.persistenceState})`)
    assert(ready?.redis === 'connected', `production /ready redis connected (got ${ready?.redis})`)
  } catch (e) {
    failures++
    console.error('FAIL: production boot probe threw —', e?.message || e)
    console.error('--- server output ---\n' + out.slice(-3000))
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 1500))
    try { child.kill('SIGKILL') } catch (_) {}
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
    if (redisStartedByUs) {
      spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.redis-host.yml', 'down', '-v'], { cwd: repoRoot, encoding: 'utf8' })
      console.log('PASS: ephemeral redis cleaned (down -v)')
    }
  }
} else {
  // No Docker: verify production fail-fast without Redis (correct behavior),
  // full boot stays BLOCKED.
  const { child, tmpRoot } = await bootProdServer({})
  let out = ''
  child.stdout.on('data', (d) => { out += String(d) })
  child.stderr.on('data', (d) => { out += String(d) })
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 20000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  try {
    assert(exited !== 0 && exited !== null, `production without Redis fail-fast exits non-zero (got ${exited})`)
    assert(out.includes('Redis unavailable') || out.includes('FATAL'), 'production without Redis logs Redis FATAL diagnostic')
    console.log('NOT VERIFIED: production full boot (/health connected) requires Docker redis')
  } catch (e) {
    failures++
    console.error('FAIL:', e?.message || e)
  } finally {
    try { child.kill('SIGKILL') } catch (_) {}
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
