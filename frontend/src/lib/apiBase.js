// Single source of truth cho API origin (Item 7 — prod khác origin).
// Dev (VITE_API_BASE rỗng → '/api/v1'): giữ behavior cũ 100% (relative +
// Vite proxy). Prod (VITE_API_BASE=https://api...): suy absolute origin.
const RAW = import.meta.env.VITE_API_BASE || '/api/v1'

export function getApiBase() {
  return RAW.replace(/\/$/, '')
}

export function getApiOrigin() {
  try {
    return new URL(getApiBase(), window.location.origin).origin
  } catch {
    return window.location.origin
  }
}

export function resolveStorageUrl(key) {
  if (!key) return null
  const k = String(key).replace(/^\//, '')
  if (/^https?:\/\//i.test(k)) return k
  const path = k.startsWith('storage/') ? k : `storage/${k}`
  // Same-origin dev (base relative) → relative để ăn Vite proxy + nginx proxy.
  if (getApiBase().startsWith('/')) return `/${path}`
  return `${getApiOrigin()}/${path}`
}

export function resolveSseUrl(projectId, ticket) {
  return `${getApiBase()}/projects/${projectId}/events?ticket=${encodeURIComponent(ticket)}`
}

// '/health' | '/ready' nằm ở root server (không dưới /api/v1).
export function resolveSystemPath(p) {
  if (getApiBase().startsWith('/')) return p // dev: Vite proxy /health → :3001
  // Prod cross-origin: health nằm cùng origin API, strip trailing /api/v1.
  const base = getApiBase().replace(/\/api\/v1\/?$/, '')
  return `${base}${p}`
}
