// Refresh fallback deprecation metrics (Task 3):
// In-memory counter for deprecated body/x-refresh-token fallback usage.
// Cookie is the primary path and is NOT counted. No token values stored.
let count = 0
let lastAt = null

export function noteRefreshFallback(source) {
  if (source !== 'body' && source !== 'header') return
  count += 1
  lastAt = new Date().toISOString()
}

export function getRefreshFallbackStats() {
  return { count, lastAt, deprecated: true, removalTarget: 'v2' }
}
