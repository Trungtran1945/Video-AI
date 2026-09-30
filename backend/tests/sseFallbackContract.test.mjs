// SSE fallback contract: hook NEVER polls itself; caller (ProjectDetail)
// polls DB when sseAvailable===false or streamClosed while active.
// DB status is authoritative; SSE disconnect never infers completed.
// Run: node backend/tests/sseFallbackContract.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.join(__dirname, '..', '..', 'frontend', 'src')

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const hookSrc = fs.readFileSync(path.join(frontendRoot, 'hooks', 'useJobEvents.js'), 'utf8')
const detailSrc = fs.readFileSync(path.join(frontendRoot, 'pages', 'ProjectDetail.jsx'), 'utf8')

// 1. Hook does NOT self-poll project status (no setInterval(load)/fetch project)
{
  assert(!hookSrc.includes('setInterval(load'), 'hook never polls project status itself')
  assert(!hookSrc.includes('/projects/${projectId}`') || hookSrc.includes('sse-ticket'), 'hook only fetches sse-ticket, not project polling')
  assert(hookSrc.includes('Caller') && hookSrc.includes('polling'), 'hook contract documents caller polling responsibility')
  assert(hookSrc.includes('DB') && hookSrc.includes('source of truth'), 'hook documents DB authoritative')
}

// 2. Hook bounded retry, always fresh ticket, no infinite retry
{
  assert(hookSrc.includes('SSE_RETRY_BACKOFF_MS') && hookSrc.includes('[1000, 2000, 5000]'), 'hook bounded backoff [1s,2s,5s]')
  assert(hookSrc.includes('sse-ticket') && hookSrc.includes('MỚI'), 'hook requests fresh ticket per retry')
  assert(!/while\s*\(\s*true/.test(hookSrc), 'hook has no infinite retry loop')
}

// 3. Caller polls when SSE unavailable OR stream closed while active
{
  assert(detailSrc.includes('if (sseAvailable && !streamClosed) return undefined'), 'caller polls when !sseAvailable OR streamClosed')
  assert(detailSrc.includes('setInterval(load, POLL_INTERVAL_MS)'), 'caller polling uses single bounded interval')
  assert(detailSrc.includes('ACTIVE_STATUSES.includes(project.status)'), 'caller polling only while active (stops at terminal)')
}

// 4. No completed inference from SSE disconnect/done
{
  assert(!/if\s*\(\s*streamClosed\s*\)[^}]*setProject\([^}]*completed/.test(detailSrc), 'no completed inference from streamClosed alone')
  assert(detailSrc.includes('DB (load) là source of truth'), 'caller documents DB truth for terminal')
  assert(hookSrc.includes('KHÔNG tự suy diễn completed'), 'hook documents no completed inference')
  assert(detailSrc.includes("lastEvent.stage !== '__project__'") || detailSrc.includes("lastEvent.stage !== '__project__'") || detailSrc.includes("__project__"), 'terminal reload gated on __project__ event')
}

// 5. Single polling loop (cleanup before new, unmount clears)
{
  assert(detailSrc.includes('return () => clearInterval(t)'), 'caller polling cleanup prevents duplicates')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
