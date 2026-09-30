// Docker Compose integration: validates compose config and, when a Docker
// daemon is available, boots redis+api and verifies real Redis connectivity
// via GET /health + GET /ready. Never fakes PASS with static string asserts.
// If Docker is unavailable the integration is BLOCKED (exit 0 with marker),
// never reported as PASS for runtime connectivity.
// Run: node backend/tests/dockerIntegration.test.mjs
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

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts })
}

// 1. Compose config is valid (static, always runs)
{
  const r = run('docker', ['compose', 'config', '--quiet'], { cwd: repoRoot })
  if (r.error && String(r.error?.code) === 'ENOENT') {
    console.log('BLOCKED: docker CLI not found — compose config NOT VERIFIED')
  } else {
    assert(r.status === 0, `docker compose config valid (exit ${r.status})${r.status !== 0 ? ` stderr=${String(r.stderr).slice(0, 500)}` : ''}`)
  }
}

// 2. Docker daemon availability probe
let daemonOk = false
{
  const r = run('docker', ['info'], { cwd: repoRoot })
  daemonOk = r.status === 0
  if (!daemonOk) {
    console.log('BLOCKED: docker daemon unavailable — Redis runtime connectivity NOT VERIFIED (config smoke only)')
  } else {
    console.log('PASS: docker daemon available')
  }
}

// 3. Runtime integration (only when daemon is available)
if (daemonOk) {
  const strong = (s) => `${s}-0123456789abcdef0123456789abcdef0123456789abcdef`
  const env = {
    ...process.env,
    JWT_ACCESS_SECRET: strong('ci-access'),
    JWT_REFRESH_SECRET: strong('ci-refresh'),
    MASTER_KEY: strong('ci-master'),
    CORS_ORIGINS: 'https://app.example.com',
  }
  let upOk = false
  try {
    const up = run('docker', ['compose', 'up', '-d', 'redis', 'api'], { cwd: repoRoot, env })
    upOk = up.status === 0
    const upErr = String(up.stderr || '') + String(up.stdout || '')
    if (!upOk && (/ports are not available|address already in use|bind/i.test(upErr))) {
      console.log(`BLOCKED: host port 3001 occupied by another process — compose api NOT VERIFIED (free 3001 and rerun). Detail: ${upErr.slice(0, 300)}`)
    } else {
      assert(upOk, `docker compose up -d redis api (exit ${up.status})${upOk ? '' : ` stderr=${upErr.slice(0, 500)}`}`)
    }
    if (upOk) {
      // Wait for API health (up to ~90s): poll /health via published 3001.
      let health = null
      let ready = null
      let readyStatus = 0
      const start = Date.now()
      while (Date.now() - start < 90000) {
        await new Promise((r) => setTimeout(r, 3000))
        try {
          const hr = await fetch('http://127.0.0.1:3001/health')
          if (hr.ok || hr.status === 503) health = await hr.json().catch(() => null)
          const rr = await fetch('http://127.0.0.1:3001/ready')
          readyStatus = rr.status
          ready = await rr.json().catch(() => null)
          if (health?.database?.persistenceState && ready) break
        } catch (_) {}
      }
      assert(health?.database?.persistenceState === 'HEALTHY' || health?.database?.persistenceState === 'DEGRADED', `compose api /health persistenceState HEALTHY|DEGRADED (got ${health?.database?.persistenceState})`)
      assert(health?.redis === 'connected', `compose api /health redis connected (got ${health?.redis}) — real runtime connectivity`)
      assert(health?.bullmq === 'available', `compose api /health bullmq available (got ${health?.bullmq})`)
      assert((readyStatus === 200 && ready?.ready === true) || (readyStatus === 503 && ready?.ready === false), `compose api /ready status honors readiness (got ${readyStatus}/${ready?.ready})`)
      assert(ready?.database?.persistenceState === health?.database?.persistenceState, '/ready persistenceState matches /health')
    }
  } catch (e) {
    failures++
    console.error('FAIL: docker integration probe threw —', e?.message || e)
  } finally {
    const down = run('docker', ['compose', 'down', '-v'], { cwd: repoRoot })
    if (down.status !== 0) {
      failures++
      console.error(`FAIL: docker compose down -v (exit ${down.status}) ${String(down.stderr).slice(0, 1000)}`)
    } else {
      console.log('PASS: docker compose down -v (no orphans)')
    }
  }
} else {
  console.log('NOT VERIFIED: Redis runtime connectivity requires Docker daemon')
}

if (!daemonOk) {
  // Config-only run: report BLOCKED marker but do not fail the suite.
  console.log(failures === 0 ? '\nALL PASS (config only, runtime BLOCKED)' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
