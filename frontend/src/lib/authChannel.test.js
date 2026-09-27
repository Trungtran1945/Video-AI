import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Simple pub/sub BroadcastChannel mock (no echo to sender, like the real API).
const liveChannels = new Set()
class FakeBroadcastChannel {
  constructor(name) {
    this.name = name
    this.onmessage = null
    this._handlers = new Set()
    liveChannels.add(this)
  }
  postMessage(msg) {
    for (const ch of [...liveChannels]) {
      if (ch !== this && ch.name === this.name) ch._dispatch({ data: msg })
    }
  }
  _dispatch(event) {
    for (const h of [...this._handlers]) h(event)
    if (typeof this.onmessage === 'function') this.onmessage(event)
  }
  addEventListener(type, fn) {
    if (type === 'message') this._handlers.add(fn)
  }
  removeEventListener(type, fn) {
    if (type === 'message') this._handlers.delete(fn)
  }
  close() {
    liveChannels.delete(this)
  }
}

globalThis.BroadcastChannel = FakeBroadcastChannel

const { postAccessUpdated, postLogout, subscribe } = await import('./authChannel.js')

test('postAccessUpdated delivers accessToken + user to other-tab subscriber', async () => {
  const received = []
  const unsub = subscribe((msg) => received.push(msg))
  postAccessUpdated('tok-123', { id: 1, email: 'a@x.com' })
  assert.equal(received.length, 1)
  assert.equal(received[0].type, 'access-updated')
  assert.equal(received[0].accessToken, 'tok-123')
  assert.deepEqual(received[0].user, { id: 1, email: 'a@x.com' })
  unsub()
})

test('postLogout delivers logout to other-tab subscriber', async () => {
  const received = []
  const unsub = subscribe((msg) => received.push(msg))
  postLogout()
  assert.equal(received.length, 1)
  assert.deepEqual(received[0], { type: 'logout' })
  unsub()
})

test('payload never contains refresh token material', async () => {
  const received = []
  const unsub = subscribe((msg) => received.push(msg))
  postAccessUpdated('tok-abc', { id: 2 })
  postLogout()
  for (const msg of received) {
    const serialized = JSON.stringify(msg).toLowerCase()
    assert.ok(!serialized.includes('refresh'), `payload must not contain 'refresh': ${serialized}`)
  }
  unsub()
})

test('unsubscribe stops delivery', async () => {
  const received = []
  const unsub = subscribe((msg) => received.push(msg))
  unsub()
  postAccessUpdated('tok-late', { id: 3 })
  assert.equal(received.length, 0)
})

test('noop when BroadcastChannel undefined (no-throw)', async () => {
  const RealBC = globalThis.BroadcastChannel
  // @ts-ignore — simulate old browser / node without BroadcastChannel
  globalThis.BroadcastChannel = undefined
  try {
    postAccessUpdated('tok-x', { id: 9 })
    postLogout()
    const unsub = subscribe(() => {
      throw new Error('should not be called')
    })
    assert.equal(typeof unsub, 'function')
    unsub() // must not throw
  } finally {
    globalThis.BroadcastChannel = RealBC
  }
})

test('source uses no localStorage/sessionStorage and no refresh token in channel', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(here, 'authChannel.js'), 'utf8')
  assert.ok(!src.includes('localStorage'), 'authChannel must not use localStorage')
  assert.ok(!src.includes('sessionStorage'), 'authChannel must not use sessionStorage')
  assert.ok(!src.includes('refresh_token'), 'authChannel must not reference refresh_token')
  assert.ok(!src.includes('refreshToken'), 'authChannel must not reference refreshToken')
})
