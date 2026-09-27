import { sha256 } from './crypto.js'

const FINGERPRINT_FIELDS = [
  'mode',
  'title',
  'language',
  'style',
  'targetDurationSec',
  'aspectRatio',
  'params',
  'sourceVideoKey',
  'videoHash',
  'copyrightAcknowledged',
]

function stableStringify(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

// Fingerprint of a project-creation request (Task 2). Only the 10 whitelisted
// fields participate; raw body is never stored — only the SHA-256 digest.
export function computeProjectFingerprint(input = {}) {
  const picked = {}
  for (const key of FINGERPRINT_FIELDS) {
    const v = input?.[key]
    picked[key] = v === undefined ? null : v
  }
  return sha256(stableStringify(picked))
}

export default { computeProjectFingerprint }
