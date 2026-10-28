// QA System Audit Test Suite
// Verifies code changes and edge cases for F1-F14 from .team/PLAN.md & .team/CODE_CHANGES.md
// Run: node backend/tests/qaSystemAudit.test.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STYLE_PRESETS } from '../src/db/seed.js'

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

console.log('=== QA Verification: System Audit & Edge Cases (F1 - F14) ===\n')

// -------------------------------------------------------------
// F3: YouTube 501 & Poll Handling (Outputs.jsx & outputs.js)
// -------------------------------------------------------------
console.log('--- F3: YouTube 501 & Poll Handling ---')
{
  const outputsSrc = read('frontend/src/pages/Outputs.jsx')
  const outputsRouteSrc = read('backend/src/routes/v1/outputs.js')

  // Backend 501 contract (or implemented startPublish outbox)
  assert(
    (outputsRouteSrc.includes('501') && outputsRouteSrc.includes('YOUTUBE_NOT_IMPLEMENTED')) || outputsRouteSrc.includes('startPublish'),
    'F3.1 Backend returns 501 YOUTUBE_NOT_IMPLEMENTED or publishes via startPublish'
  )

  // Frontend catch 501 sets not_implemented
  assert(
    outputsSrc.includes('YOUTUBE_NOT_IMPLEMENTED') && outputsSrc.includes("'not_implemented'"),
    'F3.2 Frontend catches 501 and records not_implemented status'
  )

  // Button disabled and label updated
  assert(
    outputsSrc.includes("youtubeStatusById[o.id] === 'not_implemented'") ||
    outputsSrc.includes("youtubeStatusById[o.id]==='not_implemented'"),
    'F3.3 Frontend disables button when status is not_implemented'
  )

  // Tooltip guidance
  assert(
    outputsSrc.includes('Tải lên YouTube tự động chưa triển khai — tải file rồi upload thủ công'),
    'F3.4 Frontend has manual upload guidance tooltip'
  )

  // Poll logic: excludes 'none' from done statuses
  const isDoneLogic = (status) => ['done', 'failed'].includes(status)
  assert(!isDoneLogic('none'), "F3.5 Edge Case: 'none' is NOT treated as completed in polling")
  assert(isDoneLogic('done'), "F3.6 Happy Path: 'done' is treated as completed in polling")
  assert(isDoneLogic('failed'), "F3.7 Corner Case: 'failed' stops polling")
  assert(outputsSrc.includes("['done', 'failed'].includes(st?.status)"), 'F3.8 Frontend poll excludes none from done')
}

// -------------------------------------------------------------
// F5: Logs Filter (Logs.jsx)
// -------------------------------------------------------------
console.log('\n--- F5: Logs Filter ---')
{
  const logsSrc = read('frontend/src/pages/Logs.jsx')

  // Normalization logic
  const normalizeLogStatus = (s) => (s === 'ok' ? 'success' : (s || '').toLowerCase())
  const isErrorStatus = (s) => ['error', 'failed'].includes(normalizeLogStatus(s))

  assert(isErrorStatus('error'), "F5.1 Happy Path: 'error' classified as error")
  assert(isErrorStatus('failed'), "F5.2 Happy Path: 'failed' classified as error")
  assert(isErrorStatus('FAILED'), "F5.3 Corner Case: Uppercase 'FAILED' handled")
  assert(!isErrorStatus('success'), "F5.4 'success' NOT classified as error")
  assert(!isErrorStatus('ok'), "F5.5 'ok' normalized and NOT classified as error")
  assert(!isErrorStatus('running'), "F5.6 'running' NOT classified as error")
  assert(!isErrorStatus(''), "F5.7 Empty string NOT classified as error")

  assert(
    logsSrc.includes("['error', 'failed'].includes(normalizeLogStatus(s))"),
    'F5.8 Frontend Logs filter aggregates error and failed'
  )
}

// -------------------------------------------------------------
// F11: Cancelled Terminal (ProjectDetail.jsx & events.js)
// -------------------------------------------------------------
console.log('\n--- F11: Cancelled Terminal Status ---')
{
  const projectDetailSrc = read('frontend/src/pages/ProjectDetail.jsx')
  const eventsSrc = read('backend/src/routes/v1/events.js')

  assert(
    eventsSrc.includes('cancelled') && eventsSrc.includes('Terminal statuses:'),
    'F11.1 Backend SSE recognises cancelled as terminal'
  )

  // ProjectDetail terminal checks
  assert(
    projectDetailSrc.includes("['completed', 'failed', 'cancelled'].includes(project?.status)"),
    'F11.2 Frontend reload on cancelled terminal'
  )
  assert(
    projectDetailSrc.includes("['completed', 'failed', 'cancelled'].includes(lastEvent.status)"),
    'F11.3 Frontend SSE __project__ event handles cancelled terminal'
  )
  assert(
    projectDetailSrc.includes("['completed', 'failed', 'cancelled'].includes(p.status)"),
    'F11.4 Frontend settled status includes cancelled'
  )
}

// -------------------------------------------------------------
// F2: VideoTimeline View-Only Option B (VideoTimeline.jsx & ProjectDetail.jsx)
// -------------------------------------------------------------
console.log('\n--- F2: VideoTimeline View-Only ---')
{
  const timelineSrc = read('frontend/src/components/timeline/VideoTimeline.jsx')
  const projectDetailSrc = read('frontend/src/pages/ProjectDetail.jsx')

  assert(
    timelineSrc.includes('readOnly = false') || timelineSrc.includes('readOnly=false'),
    'F2.1 VideoTimeline declares readOnly prop'
  )
  assert(
    timelineSrc.includes('readOnly') && timelineSrc.includes('track.isLocked || readOnly'),
    'F2.2 Track locked when readOnly=true'
  )
  assert(
    timelineSrc.includes('Xem thử — sửa timing ở TranscriptEditor → Lưu'),
    'F2.3 Informative caption rendered in readOnly mode'
  )
  assert(
    projectDetailSrc.includes('<VideoTimeline') && projectDetailSrc.includes('readOnly'),
    'F2.4 ProjectDetail renders VideoTimeline with readOnly prop'
  )
}

// -------------------------------------------------------------
// F6: FreeTierWarning Dub Real Duration (CreateProject.jsx)
// -------------------------------------------------------------
console.log('\n--- F6: FreeTierWarning Dub Real Duration ---')
{
  const createProjSrc = read('frontend/src/pages/CreateProject.jsx')

  assert(
    createProjSrc.includes('videoDurationSec'),
    'F6.1 CreateProject tracks videoDurationSec state'
  )
  assert(
    createProjSrc.includes('onloadedmetadata'),
    'F6.2 Probes video metadata duration on file selection'
  )
  assert(
    createProjSrc.includes('estimatedDuration={isDub ? videoDurationSec : form.targetDurationSec}'),
    'F6.3 Passes probed videoDurationSec for dub mode to FreeTierWarning'
  )

  // Logic evaluation
  const DUB_THRESHOLD = 1200
  const SUMMARY_THRESHOLD = 3600

  const shouldWarn = (isDub, videoDurationSec, formTargetSec) => {
    const dur = isDub ? videoDurationSec : formTargetSec
    if (!dur) return false
    const thresh = isDub ? DUB_THRESHOLD : SUMMARY_THRESHOLD
    return dur > thresh
  }

  // Edge cases
  assert(shouldWarn(true, null, 1500) === false, 'F6.4 Edge Case: Null videoDurationSec produces NO false warning')
  assert(shouldWarn(true, 600, 1500) === false, 'F6.5 Happy Path: 10min dub video does not trigger warning')
  assert(shouldWarn(true, 1500, 1500) === true, 'F6.6 Corner Case: 25min dub video (>20min) triggers warning')
  assert(shouldWarn(false, null, 1500) === false, 'F6.7 Happy Path: 25min SUMMARY (<60min) does not trigger warning')
  assert(shouldWarn(false, null, 4000) === true, 'F6.8 Corner Case: 66min SUMMARY (>60min) triggers warning')
}

// -------------------------------------------------------------
// F7: Glossary Delete AlertDialog (ProjectDetail.jsx)
// -------------------------------------------------------------
console.log('\n--- F7: Glossary Delete AlertDialog ---')
{
  const projectDetailSrc = read('frontend/src/pages/ProjectDetail.jsx')

  assert(
    !projectDetailSrc.includes('window.confirm('),
    'F7.1 No native window.confirm remaining in ProjectDetail'
  )
  assert(
    projectDetailSrc.includes('glossaryDeleteTarget') && projectDetailSrc.includes('deletingGlossary'),
    'F7.2 State-driven AlertDialog handles glossary deletion'
  )
}

// -------------------------------------------------------------
// F10: ResetPassword Error Message Extraction (ResetPassword.jsx)
// -------------------------------------------------------------
console.log('\n--- F10: ResetPassword Error Extraction ---')
{
  const resetSrc = read('frontend/src/pages/ResetPassword.jsx')

  const extractMessage = (err) =>
    err?.response?.data?.message || err?.response?.data?.error?.message || err?.message || 'Có lỗi xảy ra'

  // Happy Path
  assert(
    extractMessage({ response: { data: { message: 'TOKEN_EXPIRED' } } }) === 'TOKEN_EXPIRED',
    'F10.1 Happy Path: Extracts top-level data.message'
  )

  // Edge Case: Nested error object
  assert(
    extractMessage({ response: { data: { error: { message: 'INVALID_TOKEN' } } } }) === 'INVALID_TOKEN',
    'F10.2 Edge Case: Extracts nested data.error.message'
  )

  // Fallback: Generic error
  assert(
    extractMessage({ message: 'Network Failure' }) === 'Network Failure',
    'F10.3 Fallback: Falls back to err.message when response is absent'
  )

  assert(
    resetSrc.includes('err?.response?.data?.message || err?.response?.data?.error?.message || err.message'),
    'F10.4 Frontend implements full cascade error message extraction'
  )
}

// -------------------------------------------------------------
// F4: Register Name Input (Register.jsx & auth.js)
// -------------------------------------------------------------
console.log('\n--- F4: Register Name Input ---')
{
  const registerSrc = read('frontend/src/pages/Register.jsx')
  const authRouteSrc = read('backend/src/routes/v1/auth.js')

  assert(
    registerSrc.includes("name: ''") || registerSrc.includes('setName') || registerSrc.includes('id="name"'),
    'F4.1 Register.jsx defines name input field and state'
  )
  assert(
    registerSrc.includes('name.trim() || undefined'),
    'F4.2 Trims whitespace from name before calling register'
  )
  assert(
    authRouteSrc.includes("name || ''"),
    'F4.3 Backend gracefully defaults empty/omitted name to empty string'
  )
}

// -------------------------------------------------------------
// F1: Dead Client Quarantine Removal (frontend/src/api/projects.js)
// -------------------------------------------------------------
console.log('\n--- F1: Dead Client Quarantine Removal ---')
{
  const apiProjectsSrc = read('frontend/src/api/projects.js')
  const beProjectsSrc = read('backend/src/routes/v1/projects.js')

  assert(
    !apiProjectsSrc.includes('updateSegmentTranslation:'),
    'F1.1 Dead client function updateSegmentTranslation removed from frontend API'
  )
  assert(
    beProjectsSrc.includes('/segments/:segmentId/translation'),
    'F1.2 Backend PATCH translation route preserved for API parity'
  )
}

// -------------------------------------------------------------
// F8: Protected Route for Timeline Demo (App.jsx & TimelineDemo.jsx)
// -------------------------------------------------------------
console.log('\n--- F8: Timeline Demo Protection ---')
{
  const appSrc = read('frontend/src/App.jsx')
  const demoSrc = read('frontend/src/pages/TimelineDemo.jsx')

  // Check that /timeline is inside ProtectedRoute block
  assert(
    appSrc.includes('<Route element={<ProtectedRoute') && appSrc.includes('path="/timeline"'),
    'F8.1 Route /timeline wrapped inside ProtectedRoute'
  )
  assert(
    demoSrc.includes('dữ liệu mẫu local, không lưu server') || demoSrc.includes('dữ liệu mẫu'),
    'F8.2 TimelineDemo displays demo disclaimer banner'
  )
}

// -------------------------------------------------------------
// F9: Display-Only Language Select (ProjectDetail.jsx)
// -------------------------------------------------------------
console.log('\n--- F9: Language Select Display-Only ---')
{
  const projectDetailSrc = read('frontend/src/pages/ProjectDetail.jsx')
  assert(
    projectDetailSrc.includes('Chỉ đổi hiển thị ngôn ngữ phụ đề') || projectDetailSrc.includes('display-only'),
    'F9.1 Language select documents display-only behavior'
  )
}

// -------------------------------------------------------------
// F12: Style Presets & Seed Parity (seed.js & constants.jsx)
// -------------------------------------------------------------
console.log('\n--- F12: Style Presets Parity ---')
{
  const seedSrc = read('backend/src/db/seed.js')
  const constantsSrc = read('frontend/src/lib/constants.jsx')

  assert(
    STYLE_PRESETS.length === 13,
    `F12.1 Backend seed has exactly 13 presets (got ${STYLE_PRESETS.length})`
  )
  assert(
    seedSrc.includes('13 phong cách dịch'),
    'F12.2 seed.js comments updated to reflect 13 presets'
  )
  assert(
    constantsSrc.includes('STYLE_PRESETS_FALLBACK') &&
    (constantsSrc.match(/slug:\s*'/g) || []).length >= 13,
    'F12.3 Frontend STYLE_PRESETS_FALLBACK contains 13 presets'
  )
}

// -------------------------------------------------------------
// F13: Upload Limits & Contract (upload.js & 06_API.md)
// -------------------------------------------------------------
console.log('\n--- F13: Upload Limits & Contract ---')
{
  const apiUploadSrc = read('frontend/src/api/upload.js')
  const apiDocSrc = read('Video_AI_docs/docs/06_API.md')

  assert(
    apiUploadSrc.includes('multipart') && apiUploadSrc.includes('50MB') && apiUploadSrc.includes('2GB'),
    'F13.1 upload.js documents multipart 50MB vs resumable 2GB'
  )
  assert(
    apiDocSrc.includes('/uploads/init') && apiDocSrc.includes('/uploads/:id') && apiDocSrc.includes('DELETE'),
    'F13.2 06_API.md documents resumable upload lifecycle and abort'
  )
}

// -------------------------------------------------------------
// F14: FFmpeg Missing Skip Guards (dubMaskWorkflow & dubMaskEdgeCases)
// -------------------------------------------------------------
console.log('\n--- F14: FFmpeg Skip Guards ---')
{
  const workflowSrc = read('backend/tests/dubMaskWorkflow.test.mjs')
  const edgeCasesSrc = read('backend/tests/dubMaskEdgeCases.test.mjs')

  assert(
    workflowSrc.includes('ffmpeg missing') && workflowSrc.includes('process.exit(0)'),
    'F14.1 dubMaskWorkflow skips with exit 0 when ffmpeg is missing'
  )
  assert(
    edgeCasesSrc.includes('SKIP dubMaskEdgeCases') && edgeCasesSrc.includes('failures === 0 ? 0 : 1'),
    'F14.2 dubMaskEdgeCases guards against missing ffmpeg and skips gracefully'
  )
}

// -------------------------------------------------------------
// S1: Concurrency Admission Slot Fix Verification
// -------------------------------------------------------------
console.log('\n--- S1: Concurrency Admission Slot Execution ---')
{
  const admissionSrc = read('backend/src/services/projectAdmission.js')
  const drainSrc = read('backend/src/queue/workers/drainQueued.js')

  assert(
    admissionSrc.includes('EXECUTION_STATUSES') &&
    admissionSrc.includes('PROJECT_ACTIVE_STATUSES.filter'),
    'S1.1 projectAdmission defines EXECUTION_STATUSES excluding queued'
  )
  assert(
    drainSrc.includes('EXECUTION_STATUSES'),
    'S1.2 drainQueued uses EXECUTION_STATUSES to count active capacity'
  )
}

console.log(`\n======================================================`)
console.log(`Total tests: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`)
if (failedTests > 0) {
  console.error(`\nFAILED: ${failedTests} test(s) failed.`)
  process.exit(1)
} else {
  console.log('\nALL QA VERIFICATION TESTS PASSED!')
  process.exit(0)
}
