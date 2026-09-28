// SSE terminal race: subscribe eventBus TRƯỚC khi check DB terminal lần cuối.
// - publish trước subscribe bị mất (EventEmitter không replay) → chứng minh race window.
// - publish sau subscribe luôn tới listener → subscribe-first loại bỏ window.
// - events.js phải subscribe trước SELECT status (static order assertion).
// Chạy: node tests/sseTerminalRace.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'v1', 'events.js'), 'utf8')

const eventBus = (await import('../src/pipeline/eventBus.js')).default

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

// 1. events.js subscribe trước DB terminal check (race-safe ordering).
{
  const iSub = src.indexOf('eventBus.subscribe')
  const iSel = src.indexOf('SELECT status, progress FROM projects')
  assert(iSub > 0 && iSel > 0 && iSub < iSel, 'subscribe eventBus trước SELECT terminal (race-safe)')
}

// 2. Re-check sau subscribe vẫn trả terminal progress + done rồi đóng stream.
{
  assert(src.includes('event: progress') && src.includes('event: done'), 'terminal trả progress + done')
  assert(src.includes('cleanup()') && src.includes("res.end()"), 'terminal cleanup + end stream')
}

// 3. Cleanup an toàn: guard đóng lặp, clear heartbeat, unsubscribe.
{
  assert(src.includes('clearInterval(heartbeat)'), 'cleanup clear heartbeat')
  assert(src.includes('unsubscribe()'), 'cleanup unsubscribe')
  assert(src.includes("req.on('close', cleanup)"), 'cleanup khi client ngắt')
}

// 4. EventEmitter không replay: publish trước subscribe bị mất.
{
  const pid = `race-miss-${Date.now()}`
  eventBus.publish(pid, { stage: '__project__', status: 'completed', percent: 100 })
  let got = null
  const unsub = eventBus.subscribe(pid, (p) => { got = p })
  await new Promise((r) => setTimeout(r, 20))
  assert(got === null, 'publish trước subscribe bị mất (không replay — đúng bản chất race)')
  unsub()
}

// 5. Subscribe-first: publish sau subscribe (mô phỏng pipeline commit
//    đúng lúc setup) luôn tới listener — không mất terminal event.
{
  const pid = `race-hit-${Date.now()}`
  let got = null
  const unsub = eventBus.subscribe(pid, (p) => { got = p })
  // Giả lập: DB commit completed rồi publish terminal SAU khi đã subscribe.
  eventBus.publish(pid, { stage: '__project__', status: 'completed', percent: 100 })
  await new Promise((r) => setTimeout(r, 20))
  assert(got && got.stage === '__project__' && got.status === 'completed', 'publish sau subscribe tới listener (race-safe)')
  unsub()
}

// 6. Terminal failed cũng được phân phối qua listener đã subscribe.
{
  const pid = `race-fail-${Date.now()}`
  let got = null
  const unsub = eventBus.subscribe(pid, (p) => { got = p })
  eventBus.publish(pid, { stage: '__project__', status: 'failed', percent: 100 })
  await new Promise((r) => setTimeout(r, 20))
  assert(got && got.status === 'failed', 'failed terminal tới listener')
  unsub()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
