// PLAN Task 0 — State vocabulary matrix (P0).
// Gate: pending/queued/running/cancelled/completed x admission/recovery/SSE/output-hidden.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROJECT_STATUS,
  PROJECT_ACTIVE_STATUSES,
  normalizeProjectStatus,
  normalizeJobStatus,
  isActiveProjectStatus,
  isCompletedProjectStatus,
} from '../src/lib/projectStatus.js'

let failures = 0
const assert = (c, m) => {
  if (c) console.log('PASS:', m)
  else { failures += 1; console.error('FAIL:', m) }
}
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

// 1. ACTIVE contains queued (fix S1)
assert(PROJECT_ACTIVE_STATUSES.includes('queued'), 'PROJECT_ACTIVE_STATUSES contains queued')
assert(PROJECT_ACTIVE_STATUSES.includes('pending'), 'PROJECT_ACTIVE_STATUSES contains pending')
assert(PROJECT_ACTIVE_STATUSES.includes('running'), 'PROJECT_ACTIVE_STATUSES contains running')
assert(!PROJECT_ACTIVE_STATUSES.includes('completed'), 'completed is not active')

// 2. Legacy + FE-only aliases normalize on read-path (fix S2/C1)
assert(normalizeProjectStatus('success') === PROJECT_STATUS.COMPLETED, "normalizeProjectStatus('success')==='completed'")
assert(normalizeProjectStatus('generating') === PROJECT_STATUS.RUNNING, "normalizeProjectStatus('generating')==='running'")
assert(normalizeProjectStatus('completed') === 'completed', 'completed passes through')
assert(typeof normalizeJobStatus === 'function', 'normalizeJobStatus exported')
assert(normalizeJobStatus('completed') === 'success', "normalizeJobStatus('completed')==='success' (job vocab)")
assert(normalizeJobStatus('failed') === 'failed', 'job failed passes through')

// 3. Helpers shared
assert(isActiveProjectStatus('queued') === true, "isActiveProjectStatus('queued')")
assert(isActiveProjectStatus('generating') === true, "isActiveProjectStatus('generating') via normalize")
assert(isActiveProjectStatus('completed') === false, "isActiveProjectStatus('completed')===false")
assert(isCompletedProjectStatus('success') === true, "isCompletedProjectStatus('success') via normalize")
assert(isCompletedProjectStatus('completed') === true, "isCompletedProjectStatus('completed')")

// 4. Admission uses shared ACTIVE list (no hardcode pending/running only)
const admissionSrc = read('src/services/projectAdmission.js')
assert(!/IN \('pending', 'running'\)/.test(admissionSrc), 'admission has no hardcoded pending/running-only IN clause')
assert(/PROJECT_ACTIVE_STATUSES|queued/.test(admissionSrc), 'admission references queued/shared ACTIVE list')

// 5. Recovery covers queued
const recoverySrc = read('src/pipeline/recovery.js')
assert(recoverySrc.includes("'queued'") || recoverySrc.includes('"queued"'), 'recovery mentions queued')

// 6. SSE terminal includes cancelled (fix S3)
const eventsSrc = read('src/routes/v1/events.js')
assert(eventsSrc.includes('cancelled'), 'events.js mentions cancelled terminal')
assert(/completed.*failed.*cancelled|cancelled.*completed/s.test(eventsSrc), 'events.js terminal set has completed+failed+cancelled')

// 7. Output hidden while active (pending/queued/running/generating)
const projectsSrc = read('src/routes/v1/projects.js')
for (const s of ['pending', 'queued', 'running', 'generating']) {
  assert(projectsSrc.includes(`'${s}'`), `projects.js output-hidden mentions '${s}'`)
}

if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
