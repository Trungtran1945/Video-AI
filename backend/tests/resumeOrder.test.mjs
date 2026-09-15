// RED: pipeline resume must follow stage ORDER (not created_date) and must not
// skip pending/retry predecessors — otherwise retrying dub.render while
// dub.ttsAlign is pending loops BLOCK_RENDER forever (live incident d736:
// translate success, ttsAlign pending/failed, render failed x12 attempts).
// Run: node backend/tests/resumeOrder.test.mjs
import { firstRunnableStage } from '../src/pipeline/context.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const DUB = ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.ttsAlign', 'dub.render']
const J = (type, status, extra = {}) => ({ type, status, next_retry_at: null, ...extra })

// 1. all success -> nothing to run
{
  const r = firstRunnableStage(DUB, DUB.map((t) => J(t, 'success')))
  assert(r.type === null && r.waiting === false, 'all success -> done')
}

// 2. live d736 shape: translate ok, ttsAlign pending/failed, render failed -> ttsAlign
{
  const jobs = [
    J('dub.ingest', 'success'), J('dub.stt', 'success'), J('dub.merge', 'success'),
    J('dub.translate', 'success'), J('dub.ttsAlign', 'failed'), J('dub.render', 'failed'),
  ]
  const r = firstRunnableStage(DUB, jobs)
  assert(r.type === 'dub.ttsAlign' && r.waiting === false, `failed predecessor wins over failed render (got ${r.type})`)
}

// 3. order beats created_date: render failed but ttsAlign only pending -> ttsAlign
{
  const jobs = [
    J('dub.ingest', 'success'), J('dub.stt', 'success'), J('dub.merge', 'success'),
    J('dub.translate', 'success'), J('dub.ttsAlign', 'pending'), J('dub.render', 'failed'),
  ]
  const r = firstRunnableStage(DUB, jobs)
  assert(r.type === 'dub.ttsAlign', `pending predecessor before failed render (got ${r.type})`)
}

// 4. retry-waiting (cooldown in future) -> waiting, must NOT launch downstream
{
  const future = new Date(Date.now() + 60_000).toISOString()
  const jobs = [
    J('dub.ingest', 'success'), J('dub.stt', 'success'), J('dub.merge', 'success'),
    J('dub.translate', 'success'), J('dub.ttsAlign', 'retry', { next_retry_at: future }), J('dub.render', 'failed'),
  ]
  const r = firstRunnableStage(DUB, jobs)
  assert(r.type === 'dub.ttsAlign' && r.waiting === true && r.nextRetryAt === future, 'retry cooldown -> waiting (halt, no render)')
}

// 5. retry cooldown elapsed -> runnable again
{
  const past = new Date(Date.now() - 60_000).toISOString()
  const jobs = [
    J('dub.ingest', 'success'), J('dub.stt', 'success'), J('dub.merge', 'success'),
    J('dub.translate', 'success'), J('dub.ttsAlign', 'retry', { next_retry_at: past }), J('dub.render', 'failed'),
  ]
  const r = firstRunnableStage(DUB, jobs)
  assert(r.type === 'dub.ttsAlign' && r.waiting === false, 'retry past due -> runnable')
}

// 6. missing job row (never created) -> runnable at that stage
{
  const jobs = [J('dub.ingest', 'success')]
  const r = firstRunnableStage(DUB, jobs)
  assert(r.type === 'dub.stt' && r.waiting === false, `missing row -> earliest gap (got ${r.type})`)
}

// 7. failed render with healthy chain -> just render (preserves single-job retry)
{
  const jobs = [
    J('dub.ingest', 'success'), J('dub.stt', 'success'), J('dub.merge', 'success'),
    J('dub.translate', 'success'), J('dub.ttsAlign', 'success'), J('dub.render', 'failed'),
  ]
  const r = firstRunnableStage(DUB, jobs)
  assert(r.type === 'dub.render' && r.waiting === false, 'healthy chain -> only render')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
