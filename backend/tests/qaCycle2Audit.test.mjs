// QA Cycle 2 Audit Test Suite
// Verifies code changes and edge cases for R1, R2, R3 from .team/PLAN.md Cycle 2
// Run: node backend/tests/qaCycle2Audit.test.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.join(__dirname, '..')
const repoRoot = path.join(backendRoot, '..')
const read = (relPath) => fs.readFileSync(path.join(repoRoot, relPath), 'utf8')

let totalTests = 0
let passedTests = 0
let failedTests = 0

function assert(condition, name, details = '') {
  totalTests++
  if (condition) {
    passedTests++
    console.log(`  PASS: [${name}]`)
  } else {
    failedTests++
    console.error(`  FAIL: [${name}] ${details}`)
  }
}

console.log('=== QA Verification: Cycle 2 Audit (R1, R2, R3) ===\n')

// -------------------------------------------------------------
// R1: Resumable Upload Resiliency (resumableUpload.js & CreateProject.jsx)
// -------------------------------------------------------------
console.log('--- R1: Resumable Upload Resiliency ---')
{
  const resumableSrc = read('frontend/src/api/resumableUpload.js')
  const createProjSrc = read('frontend/src/pages/CreateProject.jsx')

  // 1.1 Options & default budget
  assert(
    resumableSrc.includes('maxTransientRetries = 5') &&
    resumableSrc.includes('retryDelaysMs = [1000, 2000, 5000, 10000, 15000]'),
    'R1.1 Default transient retries increased to 5 with progressive backoff'
  )

  // 1.2 Initial upload ID and onUploadId callback
  assert(
    resumableSrc.includes('initialUploadId = null') && resumableSrc.includes('onUploadId'),
    'R1.2 Supports initialUploadId and onUploadId callback for session resume'
  )

  // 1.3 Online event listening
  assert(
    resumableSrc.includes('waitForOnline') && resumableSrc.includes("addEventListener('online'"),
    'R1.3 Listens for online event before re-syncing'
  )

  // 1.4 Fatal error classification (404/410)
  assert(
    resumableSrc.includes('markFatalUpload') &&
    resumableSrc.includes('status === 404 || status === 410') &&
    resumableSrc.includes('error.fatalUpload = true'),
    'R1.4 Marks 404/410 status as fatalUpload'
  )

  // 1.5 CreateProject.jsx session storage and cancel/retry controls
  assert(
    createProjSrc.includes('sessionStorage') && createProjSrc.includes('upload-session:'),
    'R1.5 CreateProject stores upload session fingerprint in sessionStorage'
  )
  assert(
    createProjSrc.includes('handleCancelUpload') && createProjSrc.includes('uploadController?.abort?.()'),
    'R1.6 CreateProject supports user-initiated upload cancellation'
  )
  assert(
    createProjSrc.includes('handleRetryUpload') && createProjSrc.includes('initialUploadId'),
    'R1.7 CreateProject supports retry resuming from same session'
  )
  assert(
    createProjSrc.includes('Thử lại (tiếp tục từ chỗ đã dừng)') &&
    createProjSrc.includes('Hủy tải lên'),
    'R1.8 CreateProject renders explicit cancel and retry buttons'
  )
  assert(
    createProjSrc.includes('Phiên tải đã hết hạn — bấm Thử lại để tải mới từ đầu'),
    'R1.9 CreateProject informs user when session has expired'
  )
}

// -------------------------------------------------------------
// R2: Mobile Responsiveness (MaskEditor.jsx & VideoTimeline.jsx)
// -------------------------------------------------------------
console.log('\n--- R2: Mobile Responsiveness ---')
{
  const maskSrc = read('frontend/src/components/MaskEditor.jsx')
  const timelineSrc = read('frontend/src/components/timeline/VideoTimeline.jsx')

  // 2.1 MaskEditor touch target min-height 36px
  assert(
    maskSrc.includes('min-h-[36px]'),
    'R2.1 MaskEditor inputs and buttons have min-h-[36px] for touch accessibility'
  )

  // 2.2 MaskEditor grid 2-col on mobile, 4-col on desktop
  assert(
    maskSrc.includes('grid grid-cols-2 sm:grid-cols-4'),
    'R2.2 MaskEditor coordinate inputs adapt to grid-cols-2 on mobile screens'
  )

  // 2.3 MaskEditor resize handles hit-area 28px
  assert(
    maskSrc.includes('className="p-2 -m-2 flex items-center justify-center"') &&
    maskSrc.includes('Kéo để chỉnh kích thước'),
    'R2.3 MaskEditor corner resize handles have expanded touch hit-area'
  )

  // 2.4 VideoTimeline touch targets min-height 36px
  assert(
    timelineSrc.includes('min-h-[36px]') && timelineSrc.includes('min-w-[36px]'),
    'R2.4 VideoTimeline interactive buttons have min 36px dimensions'
  )

  // 2.5 VideoTimeline hides desktop shortcut hints on small screens
  assert(
    timelineSrc.includes('hidden sm:flex') && timelineSrc.includes('kbd'),
    'R2.5 VideoTimeline hides keyboard shortcuts footer on mobile devices'
  )

  // 2.6 Horizontal scroll preservation
  assert(
    timelineSrc.includes('overflow-x-auto sm:overflow-visible max-w-full'),
    'R2.6 Header toolbars allow horizontal scroll without breaking mobile layout'
  )
}

// -------------------------------------------------------------
// R3: Admin Queue Metrics (admin.js & Admin.jsx)
// -------------------------------------------------------------
console.log('\n--- R3: Admin Queue Metrics ---')
{
  const adminRouteSrc = read('backend/src/routes/v1/admin.js')
  const adminPageSrc = read('frontend/src/pages/Admin.jsx')
  const apiExtraSrc = read('frontend/src/api/extra.js')

  // 3.1 Backend route GET /admin/queue-metrics mounted
  assert(
    adminRouteSrc.includes("router.get('/queue-metrics'"),
    'R3.1 Backend exposes GET /admin/queue-metrics route'
  )

  // 3.2 Degraded Redis handling
  assert(
    adminRouteSrc.includes('REDIS_UNAVAILABLE') &&
    adminRouteSrc.includes('QUEUE_SNAPSHOT_TIMEOUT_MS'),
    'R3.2 Queue metrics endpoint handles Redis degradation with timeout fallback'
  )

  // 3.3 DB fallback counts
  assert(
    adminRouteSrc.includes('byProjectStatus') &&
    adminRouteSrc.includes('oldestQueuedAgeMs'),
    'R3.3 Returns DB fallback counts for active and queued projects'
  )

  // 3.4 Client API helper in extra.js
  assert(
    apiExtraSrc.includes('queueMetrics: () => api.get(') ||
    apiExtraSrc.includes("queueMetrics: () => api.get('/admin/queue-metrics')"),
    'R3.4 frontend extra.js provides adminApi.queueMetrics'
  )

  // 3.5 Admin.jsx StatCards
  assert(
    adminPageSrc.includes('Chờ xử lý') &&
    adminPageSrc.includes("projects.filter(p => p.status === 'queued')") &&
    adminPageSrc.includes('Chờ lâu nhất từ'),
    'R3.5 Admin.jsx renders Queued StatCard with oldest project sublabel'
  )
  assert(
    adminPageSrc.includes('Đang chạy') &&
    adminPageSrc.includes("['running', 'pending'].includes(p.status)"),
    'R3.6 Admin.jsx renders Running StatCard'
  )

  // 3.6 BullMQ card & Redis down amber banner
  assert(
    adminPageSrc.includes('BullMQ: ') &&
    adminPageSrc.includes('Redis down — workers tạm dừng'),
    'R3.7 Admin.jsx displays BullMQ worker card and amber banner when Redis disconnected'
  )

  // 3.7 Link to queue detail
  assert(
    adminPageSrc.includes('to="/queue"') && adminPageSrc.includes('Xem chi tiết →'),
    'R3.8 Admin.jsx links to /queue for deep inspection'
  )
}

console.log(`\n======================================================`)
console.log(`Total tests: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`)
if (failedTests > 0) {
  console.error(`\nFAILED: ${failedTests} test(s) failed.`)
  process.exit(1)
} else {
  console.log('\nALL QA CYCLE 2 TESTS PASSED!')
  process.exit(0)
}
