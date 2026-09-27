// Cross-tab auth coordination (memory-only).
// BroadcastChannel('video-ai-auth') wrapper — never carries the refresh token
// (refresh lives in an HttpOnly cookie). Channel is memory-only: no storage.
const CHANNEL_NAME = 'video-ai-auth'

function openChannel() {
  try {
    if (typeof BroadcastChannel === 'undefined') return null
    return new BroadcastChannel(CHANNEL_NAME)
  } catch {
    return null
  }
}

export function postAccessUpdated(accessToken, user) {
  try {
    const ch = openChannel()
    if (!ch) return
    ch.postMessage({ type: 'access-updated', accessToken, user })
    if (typeof ch.close === 'function') ch.close()
  } catch {
    /* noop — cross-tab sync is best-effort */
  }
}

export function postLogout() {
  try {
    const ch = openChannel()
    if (!ch) return
    ch.postMessage({ type: 'logout' })
    if (typeof ch.close === 'function') ch.close()
  } catch {
    /* noop */
  }
}

export function subscribe(fn) {
  let ch = null
  let handler = null
  try {
    ch = openChannel()
    if (!ch) return () => {}
    handler = (event) => {
      fn(event && 'data' in event ? event.data : event)
    }
    if (typeof ch.addEventListener === 'function') {
      ch.addEventListener('message', handler)
    } else {
      ch.onmessage = handler
    }
  } catch {
    return () => {}
  }
  return () => {
    try {
      if (ch) {
        if (typeof ch.removeEventListener === 'function' && handler) {
          ch.removeEventListener('message', handler)
        } else {
          ch.onmessage = null
        }
        if (typeof ch.close === 'function') ch.close()
      }
    } catch {
      /* noop */
    }
  }
}
