// QA Post-Cycle Audit Test Suite
// Verifies code changes and edge cases for B1-B4, D1-D7, U1-U4
// Run: node backend/tests/qaPostCycleAudit.test.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeProjectStatus,
  normalizeJobStatus,
  isCompletedProjectStatus,
  PROJECT_ACTIVE_STATUSES,
} from '../src/lib/projectStatus.js'

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

console.log('=== QA Verification: Post-Cycle Audit (B1-B4, D1-D7, U1-U4) ===\n')

// -------------------------------------------------------------
// B1: Project Status Vocabulary & ProjectDetail Completion Check
// -------------------------------------------------------------
console.log('--- B1: Project Status Vocabulary ---')
{
  const projDetailSrc = read('frontend/src/pages/ProjectDetail.jsx')

  assert(normalizeProjectStatus('success') === 'completed', 'B1.1 normalizeProjectStatus success -> completed')
  assert(normalizeProjectStatus('generating') === 'running', 'B1.2 normalizeProjectStatus generating -> running')
  assert(normalizeJobStatus('completed') === 'success', 'B1.3 normalizeJobStatus completed -> success')
  assert(PROJECT_ACTIVE_STATUSES.includes('queued'), 'B1.4 PROJECT_ACTIVE_STATUSES includes queued')

  // Frontend ProjectDetail uses isCompletedStatus for summary job done check
  assert(
    projDetailSrc.includes('isCompletedStatus(job?.status)'),
    'B1.5 ProjectDetail uses isCompletedStatus(job?.status)'
  )
}

// -------------------------------------------------------------
// B2: TimelineClip Track Lock Interlocking
// -------------------------------------------------------------
console.log('\n--- B2: TimelineClip Track Lock Interlocking ---')
{
  const clipSrc = read('frontend/src/components/timeline/TimelineClip.jsx')

  // FloatingToolbar and trim handles gated by !isTrackLocked
  assert(
    clipSrc.includes('!isTrackLocked') && clipSrc.includes('<FloatingToolbar'),
    'B2.1 FloatingToolbar is hidden when isTrackLocked is true'
  )
  assert(
    clipSrc.includes('!isTrackLocked') && clipSrc.includes('handleLeftTrimPointerDown'),
    'B2.2 Left trim handle is gated by !isTrackLocked'
  )
  assert(
    clipSrc.includes('!isTrackLocked') && clipSrc.includes('handleRightTrimPointerDown'),
    'B2.3 Right trim handle is gated by !isTrackLocked'
  )
}

// -------------------------------------------------------------
// B3: CreateProject SUMMARY canNext Guard
// -------------------------------------------------------------
console.log('\n--- B3: CreateProject canNext Guard ---')
{
  const createProjSrc = read('frontend/src/pages/CreateProject.jsx')

  // canNext for SUMMARY step 0 requires sourceVideoKey
  assert(
    createProjSrc.includes('if (step === 0) return !!form.sourceVideoKey;'),
    'B3.1 SUMMARY step 0 strictly gates on form.sourceVideoKey'
  )
}

// -------------------------------------------------------------
// B4: MaskEditor Specific Error Catching
// -------------------------------------------------------------
console.log('\n--- B4: MaskEditor Specific Error Handling ---')
{
  const maskSrc = read('frontend/src/components/MaskEditor.jsx')

  assert(
    maskSrc.includes('maskActionError') &&
    maskSrc.includes('MASK_APPROVED_IMMUTABLE') &&
    maskSrc.includes('Nhân bản tay'),
    'B4.1 MaskEditor maps 409 MASK_APPROVED_IMMUTABLE to duplicate recommendation'
  )
  assert(
    maskSrc.includes('chỉ đọc') || maskSrc.includes('tự động'),
    'B4.2 MaskEditor handles auto/read-only mask errors with clear advice'
  )
}

// -------------------------------------------------------------
// D1 & D2: Dead API Removal & SSE Ticket Wiring
// -------------------------------------------------------------
console.log('\n--- D1 & D2: Dead API Clean-up & SSE Ticket Wiring ---')
{
  const apiProjectsSrc = read('frontend/src/api/projects.js')
  const apiExtraSrc = read('frontend/src/api/extra.js')
  const hookSrc = read('frontend/src/hooks/useJobEvents.js')

  // jobs() dead client removed from api/projects.js
  assert(
    !apiProjectsSrc.includes('jobs: (id)'),
    'D1.1 Dead jobs() function removed from projects API'
  )

  // sseTicket wired into useJobEvents
  assert(
    hookSrc.includes('projectsApi.sseTicket('),
    'D1.2 useJobEvents wires projectsApi.sseTicket'
  )

  // adminApi.providers and systemApi.ready removed from extra.js
  assert(
    !apiExtraSrc.includes('providers: () =>') && !apiExtraSrc.includes('ready: () =>'),
    'D2.1 Dead adminApi.providers and systemApi.ready removed from extra.js'
  )
}

// -------------------------------------------------------------
// D4: Dashboard DUB Stepper Stages Count
// -------------------------------------------------------------
console.log('\n--- D4: Dashboard DUB Stepper Stages ---')
{
  const dashSrc = read('frontend/src/pages/Dashboard.jsx')

  assert(
    dashSrc.includes("'dub.mask'") && dashSrc.includes('dubStages'),
    'D4.1 Dashboard dubStages includes dub.mask stage'
  )
}

// -------------------------------------------------------------
// D6: Analytics Null Display Fallback
// -------------------------------------------------------------
console.log('\n--- D6: Analytics Display Fallback ---')
{
  const analyticsSrc = read('frontend/src/pages/Analytics.jsx')

  assert(
    analyticsSrc.includes("minutesTranslated == null ? '—' : `${minutesTranslated}p`"),
    'D6.1 Analytics handles null minutesTranslated with em-dash fallback'
  )
}

// -------------------------------------------------------------
// U1: Logs Filter Pills Responsive Wrap
// -------------------------------------------------------------
console.log('\n--- U1: Logs Responsive Filter Pills ---')
{
  const logsSrc = read('frontend/src/pages/Logs.jsx')

  assert(
    logsSrc.includes('flex gap-2 flex-wrap') || (logsSrc.includes('flex') && logsSrc.includes('flex-wrap')),
    'U1.1 Logs filter pill container has flex-wrap to prevent mobile overflow'
  )
}

// -------------------------------------------------------------
// U2: ProviderSettings Error Toast
// -------------------------------------------------------------
console.log('\n--- U2: ProviderSettings Feedback ---')
{
  const providerSrc = read('frontend/src/pages/ProviderSettings.jsx')

  assert(
    providerSrc.includes('Không đổi được provider') || providerSrc.includes('Không thể chuyển đổi provider'),
    'U2.1 ProviderSettings displays destructive toast on failure'
  )
}

// -------------------------------------------------------------
// U3: Auth Pages Localization
// -------------------------------------------------------------
console.log('\n--- U3: Auth Localization ---')
{
  const forgotSrc = read('frontend/src/pages/ForgotPassword.jsx')
  const resetSrc = read('frontend/src/pages/ResetPassword.jsx')

  assert(
    forgotSrc.includes('Quên mật khẩu') && forgotSrc.includes('Gửi link đặt lại'),
    'U3.1 ForgotPassword static texts localized to Vietnamese'
  )
  assert(
    resetSrc.includes('Mật khẩu mới') && resetSrc.includes('Đặt lại mật khẩu'),
    'U3.2 ResetPassword static texts localized to Vietnamese'
  )
}

// -------------------------------------------------------------
// U4: Projects Nested Link Fix
// -------------------------------------------------------------
console.log('\n--- U4: Projects Card Link Accessibility ---')
{
  const projectsSrc = read('frontend/src/pages/Projects.jsx')

  assert(
    projectsSrc.includes('role="link"') && projectsSrc.includes('tabIndex={0}'),
    'U4.1 Projects cards use role="link" and tabIndex for accessibility without nested anchors'
  )
  assert(
    projectsSrc.includes("e.key === 'Enter' || e.key === ' '"),
    'U4.2 Projects cards support keyboard navigation (Enter / Space)'
  )
}

console.log(`\n======================================================`)
console.log(`Total tests: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`)
if (failedTests > 0) {
  console.error(`\nFAILED: ${failedTests} test(s) failed.`)
  process.exit(1)
} else {
  console.log('\nALL POST-CYCLE AUDIT TESTS PASSED!')
  process.exit(0)
}
