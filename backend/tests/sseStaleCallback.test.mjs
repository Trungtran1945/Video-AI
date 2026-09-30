// SSE stale-callback guard: old EventSource callbacks must not mutate
// new connection state. Static fence for generation guard in useJobEvents.
// Run: node backend/tests/sseStaleCallback.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const hookPath = path.join(__dirname, '..', '..', 'frontend', 'src', 'hooks', 'useJobEvents.js')
const src = fs.readFileSync(hookPath, 'utf8')

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

assert(src.includes('generationRef'), 'generation ref exists')
assert(src.includes('gen !== generationRef.current'), 'callbacks guard on generation')
assert(src.includes('sourceRef.current !== es'), 'EventSource identity checked before mutate')
assert(src.includes('scheduleRetry') && src.includes('gen === generationRef.current'), 'retry timer guarded by generation')
assert(src.includes('openWithTicket(attempt + 1, generationRef.current)'), 'ticket retry uses fresh generation + fresh ticket')
assert(src.includes('generationRef.current += 1'), 'generation invalidated on retry/unmount')
assert(src.includes('try { es.close() }') || src.includes('es.close()'), 'stale EventSource closed without touching new ref')
assert(src.includes('Only the current generation owns sourceRef'), 'ownership comment documents single-stream invariant')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
