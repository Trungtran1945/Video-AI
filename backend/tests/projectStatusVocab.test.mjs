// B1 — Khóa vocabulary trạng thái: success→completed, generating→running,
// normalizeJobStatus, ACTIVE gồm queued (khớp frontend constants.jsx + BE runner).
import assert from 'node:assert/strict'
import { normalizeProjectStatus, normalizeJobStatus, PROJECT_ACTIVE_STATUSES } from '../src/lib/projectStatus.js'

assert.equal(normalizeProjectStatus('success'), 'completed')
assert.equal(normalizeProjectStatus('generating'), 'running')
assert.ok(PROJECT_ACTIVE_STATUSES.includes('queued'))
assert.equal(normalizeJobStatus('completed'), 'success')

console.log('PASS: success→completed')
console.log('PASS: generating→running')
console.log('PASS: ACTIVE gồm queued')
console.log('PASS: normalizeJobStatus completed→success')
console.log('ALL PASS')
process.exit(0)
