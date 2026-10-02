import { AsyncLocalStorage } from 'node:async_hooks'

// Minimal port of TransFlow ProviderUsageScope: tracks which provider keys
// already failed within ONE stage attempt so failover lands on another key.
// AsyncLocalStorage keeps concurrent projects isolated on single Node process.
const storage = new AsyncLocalStorage()

export function openProviderScope(key, fn) {
  const scope = { key: String(key || ''), excluded: new Set(), resolved: [] }
  if (typeof fn === 'function') return storage.run(scope, fn)
  // Manual open (caller must close). Rarely used; prefer openProviderScope(key, fn).
  const prev = storage.getStore()
  storage.enterWith(scope)
  return () => {
    if (prev) storage.enterWith(prev)
  }
}

export function currentProviderScope() {
  return storage.getStore() || null
}

export function runWithProviderScope(key, fn) {
  return openProviderScope(key, fn)
}

export function recordProviderResolution(capability, providerKey) {
  const scope = storage.getStore()
  if (scope && providerKey) {
    scope.resolved.push({ capability: String(capability || ''), providerKey: String(providerKey) })
  }
}

export function excludeProviderInScope(providerKey) {
  const scope = storage.getStore()
  if (scope && providerKey) scope.excluded.add(String(providerKey))
}

export function isExcludedInScope(providerKey) {
  const scope = storage.getStore()
  return scope ? scope.excluded.has(String(providerKey)) : false
}

export function scopeKey() {
  return storage.getStore()?.key || null
}

export default {
  openProviderScope,
  runWithProviderScope,
  currentProviderScope,
  recordProviderResolution,
  excludeProviderInScope,
  isExcludedInScope,
  scopeKey,
}
