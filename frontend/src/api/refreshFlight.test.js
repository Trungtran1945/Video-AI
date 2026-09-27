import test from 'node:test'
import assert from 'node:assert/strict'
import { createSingleFlight } from './refreshFlight.js'

test('10 concurrent calls → fn runs exactly once, all get same result', async () => {
  const run = createSingleFlight()
  let calls = 0
  const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return 'tok' }
  const results = await Promise.all(Array.from({ length: 10 }, () => run(fn)))
  assert.equal(calls, 1)
  assert.deepEqual(results, Array(10).fill('tok'))
})

test('after settle, next call runs again (inflight cleared)', async () => {
  const run = createSingleFlight()
  let calls = 0
  const fn = async () => { calls++; return calls }
  await run(fn); await run(fn)
  assert.equal(calls, 2)
})

test('rejection propagates to all waiters, then clears', async () => {
  const run = createSingleFlight()
  let calls = 0
  const fail = async () => { calls++; throw new Error('401') }
  const settled = await Promise.allSettled([run(fail), run(fail), run(fail)])
  assert.equal(calls, 1)
  assert.ok(settled.every((s) => s.status === 'rejected'))
  await assert.rejects(run(fail)) // fresh attempt allowed
  assert.equal(calls, 2)
})

test('pending() exposes in-flight state', async () => {
  const run = createSingleFlight()
  assert.equal(run.pending(), false)
  const p = run(() => new Promise((r) => setTimeout(r, 5)))
  assert.equal(run.pending(), true)
  await p
  assert.equal(run.pending(), false)
})
