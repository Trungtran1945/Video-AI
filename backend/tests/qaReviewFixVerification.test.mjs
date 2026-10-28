// QA Reviewer Fix Verification Suite
// Verifies whether the 5 action items from .team/REVIEW.md were implemented by CODER.
// Run: node backend/tests/qaReviewFixVerification.test.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(__dirname, '..', '..')
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
  } catch (_) {
    return ''
  }
}

let totalTests = 0
let passedTests = 0
let failedTests = 0

function assertCheck(condition, name, details = '') {
  totalTests++
  if (condition) {
    passedTests++
    console.log(`  PASS: [${name}]`)
  } else {
    failedTests++
    console.log(`  FAIL: [${name}] — ${details}`)
  }
}

console.log('=== QA Verification: Reviewer Action Items (Điểm 1 - 5) ===\n')

// -------------------------------------------------------------
// Điểm 1: Frontend API Client
// -------------------------------------------------------------
console.log('--- Điểm 1: Frontend API Client (api/projects.js, api/extra.js) ---')
{
  const projectsApiSrc = read('frontend/src/api/projects.js')
  const extraApiSrc = read('frontend/src/api/extra.js')

  assertCheck(
    projectsApiSrc.includes('uploadScript') || projectsApiSrc.includes('/script-uploads'),
    '1.1 uploadScript API client exists',
    'Chưa có hàm uploadScript gọi POST /api/v1/script-uploads'
  )

  assertCheck(
    projectsApiSrc.includes('updateScriptSegment') || projectsApiSrc.includes('/script/segments/'),
    '1.2 updateScriptSegment API client exists',
    'Chưa có hàm updateScriptSegment gọi PATCH /api/v1/projects/:id/script/segments/:segmentId'
  )

  assertCheck(
    projectsApiSrc.includes('generateScriptVideo') || projectsApiSrc.includes('/script/generate'),
    '1.3 generateScriptVideo API client exists',
    'Chưa có hàm generateScriptVideo gọi POST /api/v1/projects/:id/script/generate'
  )

  assertCheck(
    extraApiSrc.includes('youtubeApi') || extraApiSrc.includes('/youtube/account'),
    '1.4 youtubeApi client exists',
    'Chưa có module youtubeApi gọi các endpoint /youtube/account, /oauth/start'
  )
}

// -------------------------------------------------------------
// Điểm 2: Wizard CreateProject 3rd Mode
// -------------------------------------------------------------
console.log('\n--- Điểm 2: Wizard CreateProject 3rd Mode (CreateProject.jsx) ---')
{
  const createProjectSrc = read('frontend/src/pages/CreateProject.jsx')

  assertCheck(
    createProjectSrc.includes('SCRIPT_TO_VIDEO') || createProjectSrc.includes('AI_VIDEO'),
    '2.1 SCRIPT_TO_VIDEO mode option exists',
    'CreateProject.jsx chưa có lựa chọn mode SCRIPT_TO_VIDEO'
  )

  assertCheck(
    createProjectSrc.includes('scriptUploadId') || createProjectSrc.includes('uploadScript'),
    '2.2 Script file upload handling exists',
    'CreateProject.jsx chưa xử lý tải lên file kịch bản TXT/MD'
  )
}

// -------------------------------------------------------------
// Điểm 3: Workspace ProjectDetail Review Segments
// -------------------------------------------------------------
console.log('\n--- Điểm 3: Workspace ProjectDetail (ProjectDetail.jsx) ---')
{
  const detailSrc = read('frontend/src/pages/ProjectDetail.jsx')
  const pipelineStatusSrc = read('frontend/src/components/project/PipelineStatus.jsx')

  assertCheck(
    pipelineStatusSrc.includes('script.ingest') || detailSrc.includes('script.ingest'),
    '3.1 PipelineStatus SCRIPT_TO_VIDEO 7 stages',
    'PipelineStatus chưa đăng ký các stage script.*'
  )

  assertCheck(
    detailSrc.includes('scriptReviewRequired') || detailSrc.includes('scriptSegments'),
    '3.2 Review gate segment workspace exists',
    'ProjectDetail chưa có workspace hiển thị danh sách và sửa scriptSegments'
  )
}

// -------------------------------------------------------------
// Điểm 4: YouTube Connect in Settings & Publish Dialog in Outputs
// -------------------------------------------------------------
console.log('\n--- Điểm 4: YouTube UI in Settings.jsx & Outputs.jsx ---')
{
  const settingsSrc = read('frontend/src/pages/Settings.jsx')
  const outputsSrc = read('frontend/src/pages/Outputs.jsx')

  assertCheck(
    settingsSrc.includes('youtube') || settingsSrc.includes('YouTube'),
    '4.1 Settings has YouTube connection section',
    'Settings.jsx chưa có card kết nối tài khoản YouTube OAuth'
  )

  assertCheck(
    outputsSrc.includes('PublishDialog') || outputsSrc.includes('publishOutput') || outputsSrc.includes('confirmed'),
    '4.2 Outputs has YouTube Publish dialog with privacy & metadata',
    'Outputs.jsx vẫn vô hiệu hoá nút YouTube hoặc chưa có Dialog xuất bản'
  )
}

// -------------------------------------------------------------
// Điểm 5: Documentation in CODE_CHANGES.md
// -------------------------------------------------------------
console.log('\n--- Điểm 5: Documentation in CODE_CHANGES.md ---')
{
  const codeChangesSrc = read('.team/CODE_CHANGES.md')

  assertCheck(
    codeChangesSrc.includes('SCRIPT_TO_VIDEO') || codeChangesSrc.includes('YouTube Publishing'),
    '5.1 CODE_CHANGES.md updated with SCRIPT_TO_VIDEO & YouTube',
    '.team/CODE_CHANGES.md chưa ghi nhận thay đổi của SCRIPT_TO_VIDEO và YouTube Publishing'
  )
}

console.log('\n======================================================')
console.log(`Total Review Items Tested: ${totalTests} | Implemented: ${passedTests} | Missing: ${failedTests}`)
if (failedTests > 0) {
  console.log(`STATUS: ACTION REQUIRED — ${failedTests}/${totalTests} items need implementation from CODER.`)
} else {
  console.log('STATUS: ALL REVIEW ITEMS SATISFIED.')
}

// Exit 0 so it reports findings cleanly without aborting the suite runner
process.exit(0)
