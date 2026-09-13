# Remove OCR, MaskMethod & Manual Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Loại bỏ hoàn toàn OCR stage, maskMethod, và manual timeline editing (SubRegionEditor) khỏi hệ thống VIDEO AI, chuyển sang phương pháp đơn giản: chỉ burn-in sub mới mà không mask hardsub.

**Architecture:** Pipeline TRANSLATE_DUB sẽ chạy thẳng từ dub.stt → dub.merge → dub.translate → dub.ttsAlign → dub.render mà không có dub.ocr. dubRender.js sẽ chỉ burn-in sub mới mà không áp dụng mask regions. Frontend sẽ bỏ wizard step maskMethod và SubRegionEditor.

**Tech Stack:** Node.js (Express), React (Vite), SQLite (sql.js), FFmpeg

**Spec:** `Video_AI_docs/docs/01_KIEN_TRUC_TONG_THE.md`, `Video_AI_docs/docs/05_THIET_KE_PIPELINE_CHI_TIET.md`

## Global Constraints

- JavaScript (không TypeScript) - theo CLAUDE.md
- sql.js (không Prisma) - theo CLAUDE.md
- Clean Architecture + Provider Pattern
- Không đọc thư mục transflow

---

## File Structure

### Backend Files to Modify
| File | Thay đổi |
|------|----------|
| `backend/src/pipeline/runner.js` | Xóa `dub.ocr` khỏi STAGES, RESETS, STAGE_IMPL, STAGE_PROVIDER |
| `backend/src/pipeline/stages/dubMerge.js` | Thêm checks: translation + duration + language config |
| `backend/src/pipeline/stages/dubRender.js` | Bỏ logic mask regions, chỉ giữ burn-in sub + audio mix |
| `backend/src/media/mediaService.js` | Xóa `maskRegions`, `normalizeRegion`, `regionRect`, `sampleBackgroundColor` |
| `backend/src/routes/v1/dubData.js` | Xóa endpoints `/mask-regions` |
| `backend/src/routes/v1/confirmPreview.js` | Đơn giản hóa, bỏ region update |
| `backend/src/usecases/confirmPreviewUseCase.js` | Bỏ region update logic |

### Backend Files to Delete
| File | Lý do |
|------|-------|
| `backend/src/pipeline/stages/dubOcr.js` | Không còn OCR stage |

### Frontend Files to Modify
| File | Thay đổi |
|------|----------|
| `frontend/src/lib/constants.jsx` | Xóa `MASK_METHODS` |
| `frontend/src/pages/CreateProject.jsx` | Bỏ wizard step maskMethod |
| `frontend/src/pages/ProjectDetail.jsx` | Xóa SubRegionEditor, global mask opacity slider |
| `frontend/src/api/projects.js` | Xóa `getMaskRegions`, `putMaskRegions` |

### Frontend Files to Delete
| File | Lý do |
|------|-------|
| `frontend/src/components/SubRegionEditor.jsx` | Không còn manual editing |

### Documentation Files to Modify
| File | Thay đổi |
|------|----------|
| `Video_AI_docs/docs/01_KIEN_TRUC_TONG_THE.md` | Cập nhật pipeline diagram |
| `Video_AI_docs/docs/05_THIET_KE_PIPELINE_CHI_TIET.md` | Xóa section OCR, cập nhật composite |
| `Video_AI_docs/README.md` | Cập nhật mô tả features |

---

## Task 1: Backend - Update runner.js

**Files:**
- Modify: `backend/src/pipeline/runner.js:47-53,93-175`

**Interfaces:**
- Consumes: None
- Produces: Updated STAGES, RESETS, STAGE_IMPL, STAGE_PROVIDER objects

- [ ] **Step 1: Remove dub.ocr import**

```javascript
// Find and remove this line (around line 48):
import dubOcr from './stages/dubOcr.js'
```

- [ ] **Step 2: Update STAGES.TRANSLATE_DUB**

```javascript
// Change from:
TRANSLATE_DUB: [
  'dub.ingest',
  ['dub.stt', 'dub.merge'],
  'dub.translate',
  'dub.ttsAlign',
  'dub.render',
],

// Change to:
TRANSLATE_DUB: [
  'dub.ingest',
  'dub.stt',
  'dub.merge',
  'dub.translate',
  'dub.ttsAlign',
  'dub.render',
],
```

- [ ] **Step 3: Remove dub.ocr from STAGE_IMPL**

```javascript
// Remove this line (around line 132):
'dub.ocr': dubOcr,
```

- [ ] **Step 4: Remove dub.ocr from STAGE_PROVIDER**

```javascript
// Remove this line (around line 150):
'dub.ocr': 'ocr',
```

- [ ] **Step 5: Update RESETS - remove ocrRegions from dub.ingest and dub.stt**

```javascript
// Change dub.ingest from:
'dub.ingest': ['transcriptSegments', 'ocrRegions', 'audios', 'subtitles', 'outputs'],

// Change to:
'dub.ingest': ['transcriptSegments', 'audios', 'subtitles', 'outputs'],

// Change dub.stt from:
'dub.stt': ['transcriptSegments', 'audios', 'subtitles', 'outputs'],

// This is already correct, no change needed
```

- [ ] **Step 6: Update startDubParallel function**

```javascript
// The function currently handles parallel stt + merge
// Since we're removing parallel execution, simplify to sequential
// Find startDubParallel function and replace with:

async function startDubSequential(project, setProgress, results, signal) {
  const projectId = project.id
  await ensureStageJob(projectId, 'dub.stt')
  await ensureStageJob(projectId, 'dub.merge')

  const sttJob = await loadJob(projectId, 'dub.stt')
  const sttOk = await executeStage(
    project, sttJob, {},
    (pct) => {
      const p = Math.max(0, Math.min(99, Math.round(pct)))
      updateById('generation_jobs', sttJob.id, { progress: p }).catch(() => {})
      eventBus.publish(projectId, { stage: 'dub.stt', status: 'running', percent: p })
    },
    results,
    false,
    signal
  )

  if (!sttOk) return false

  const mergeJob = await loadJob(projectId, 'dub.merge')
  const mergeOk = await executeStage(
    project, mergeJob, {},
    (pct) => {
      const p = Math.max(0, Math.min(99, Math.round(pct)))
      updateById('generation_jobs', mergeJob.id, { progress: p }).catch(() => {})
      eventBus.publish(projectId, { stage: 'dub.merge', status: 'running', percent: p })
    },
    results,
    false,
    signal
  )
  return mergeOk
}
```

- [ ] **Step 7: Update runPipeline to use sequential execution**

```javascript
// Find the parallel group handling in runPipeline (around line 460)
// Change from:
const ok = await startDubParallel(

// Change to:
const ok = await startDubSequential(
```

- [ ] **Step 8: Remove clearArtifacts ocrRegions handling**

```javascript
// Find clearArtifacts function and remove the ocrRegions case (around line 183-185):
} else if (kind === 'ocrRegions') {
  await run(`DELETE FROM ocr_regions WHERE project_id = ? AND source != 'MANUAL'`, [projectId])
  fs.rmSync(path.join(dir, 'frames'), { recursive: true, force: true })
}

// Remove this entire block
```

- [ ] **Step 9: Run lint to verify**

```bash
cd backend && npm run lint
```

---

## Task 2: Backend - Update dubMerge.js

**Files:**
- Modify: `backend/src/pipeline/stages/dubMerge.js`

**Interfaces:**
- Consumes: project object with mode, params
- Produces: Validation result with transcript count, translation status, duration check, language config

- [ ] **Step 1: Read current dubMerge.js**

```bash
cat backend/src/pipeline/stages/dubMerge.js
```

- [ ] **Step 2: Replace dubMerge.js content**

```javascript
import { query } from '../../db/query.js'
import { logProviderCall } from '../../providers/tracked.js'

/**
 * dub.merge — Stage kiểm tra barrier
 * Kiểm tra TranscriptSegment + Translation + Duration + Language config
 */
export default async function dubMerge({ project, job, setProgress }) {
  const projectId = project.id

  setProgress(10)

  // Check 1: Transcript segments exist
  const transcriptSegments = await query(
    'SELECT id, translation, start_sec, end_sec FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC',
    [projectId]
  )

  setProgress(30)

  if (transcriptSegments.length === 0) {
    throw new Error('Thiếu TranscriptSegment từ dub.stt')
  }

  // Check 2: All segments have translation
  const segmentsWithoutTranslation = transcriptSegments.filter(
    s => !s.translation || s.translation.trim() === ''
  )

  setProgress(50)

  if (segmentsWithoutTranslation.length > 0) {
    throw new Error(`${segmentsWithoutTranslation.length} segment chưa có bản dịch. Vui lòng dịch tất cả segment trước khi render.`)
  }

  // Check 3: Duration validation (>0 and reasonable)
  const invalidDurationSegments = transcriptSegments.filter(s => {
    const duration = s.end_sec - s.start_sec
    return duration <= 0 || duration > 300 // max 5 minutes per segment
  })

  setProgress(70)

  if (invalidDurationSegments.length > 0) {
    throw new Error(`${invalidDurationSegments.length} segment có duration không hợp lệ (phải >0 và <=300s)`)
  }

  // Check 4: Language config
  const params = parseParams(project.params)
  if (!params.sourceLanguage || !params.targetLanguage) {
    throw new Error('Thiếu sourceLanguage hoặc targetLanguage trong project params')
  }

  setProgress(90)

  await logProviderCall({
    projectId,
    jobId: job.id,
    provider: 'core',
    type: 'media',
    status: 'ok',
    durationMs: 0,
  })

  setProgress(100)

  return {
    transcriptSegments: transcriptSegments.length,
    translatedSegments: segmentsWithoutTranslation.length === 0 ? transcriptSegments.length : 0,
    allDurationsValid: invalidDurationSegments.length === 0,
    languagesConfigured: true,
  }
}

function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}
```

- [ ] **Step 3: Run lint to verify**

```bash
cd backend && npm run lint
```

---

## Task 3: Backend - Update dubRender.js

**Files:**
- Modify: `backend/src/pipeline/stages/dubRender.js`

**Interfaces:**
- Consumes: project, query results
- Produces: Output video without mask regions

- [ ] **Step 1: Remove maskRegions import**

```javascript
// Change import from:
import {
  maskRegions,
  normalizeRegion,
  burnSubtitlesStyled,
  buildDubTrack,
  muxStream,
  makeThumbnail,
  probe,
} from '../../media/mediaService.js'

// Change to:
import {
  burnSubtitlesStyled,
  buildDubTrack,
  muxStream,
  makeThumbnail,
  probe,
} from '../../media/mediaService.js'
```

- [ ] **Step 2: Remove mask regions logic from dubRender function**

```javascript
// Find and remove the entire mask regions section (around lines 36-71):
// ── 1. Mask hardsub theo OcrRegion (docs/05 §B.6) ─────────────────────
let regions = (await query(
  'SELECT * FROM ocr_regions WHERE project_id = ? ORDER BY start_sec ASC',
  [project.id]
)).map(normalizeRegion)
// ... entire mask logic until workingFile = src

// Replace with just:
let workingFile = src
```

- [ ] **Step 3: Update buildAss call to pass empty regions**

```javascript
// Find the buildAss call (around line 81):
const assPath = buildAss(dir, segments, regions, {

// Change to:
const assPath = buildAss(dir, segments, [], {
```

- [ ] **Step 4: Update buildAss function to handle empty regions**

```javascript
// The buildAss function should work with empty regions
// Just verify it handles regions = [] correctly (it should, as pickRegion returns null)
```

- [ ] **Step 5: Remove regionCount from return**

```javascript
// Find return statement (around line 171):
return {
  outputKey,
  thumbnailKey: thumbKey,
  durationSec: round3(finalInfo.durationSec),
  regionCount: regions.length,  // Remove this line
  burnedCues: segments.length,
  dubbedAudio: enableDubbing,
}

// Change to:
return {
  outputKey,
  thumbnailKey: thumbKey,
  durationSec: round3(finalInfo.durationSec),
  burnedCues: segments.length,
  dubbedAudio: enableDubbing,
}
```

- [ ] **Step 6: Run lint to verify**

```bash
cd backend && npm run lint
```

---

## Task 4: Backend - Update mediaService.js

**Files:**
- Modify: `backend/src/media/mediaService.js`

**Interfaces:**
- Consumes: None
- Produces: Removed mask-related functions

- [ ] **Step 1: Remove sampleBackgroundColor function**

```javascript
// Find and remove the entire sampleBackgroundColor function (around lines 385-400):
export async function sampleBackgroundColor(src, atSec, region, videoDims) {
  // ... entire function
}
```

- [ ] **Step 2: Remove normalizeRegion function**

```javascript
// Find and remove the entire normalizeRegion function (around lines 404-425):
export function normalizeRegion(row) {
  // ... entire function
}
```

- [ ] **Step 3: Remove regionRect function**

```javascript
// Find and remove the entire regionRect function (around lines 428-437):
function regionRect(r, videoDims) {
  // ... entire function
}
```

- [ ] **Step 4: Remove strengthOf function**

```javascript
// Find and remove the entire strengthOf function (around lines 439-441):
function strengthOf(r) {
  // ... entire function
}
```

- [ ] **Step 5: Remove enableExpr function**

```javascript
// Find and remove the entire enableExpr function (around lines 444-449):
function enableExpr(r) {
  // ... entire function
}
```

- [ ] **Step 6: Remove maskRegions function**

```javascript
// Find and remove the entire maskRegions function (around lines 453-499):
export async function maskRegions(src, regions, out, { method = 'fill', videoDims, timeout = 0 } = {}) {
  // ... entire function
}
```

- [ ] **Step 7: Remove exports**

```javascript
// Find the exports at the end of the file and remove:
sampleBackgroundColor,
maskRegions,
normalizeRegion,
```

- [ ] **Step 8: Run lint to verify**

```bash
cd backend && npm run lint
```

---

## Task 5: Backend - Update routes

**Files:**
- Modify: `backend/src/routes/v1/dubData.js`
- Modify: `backend/src/routes/v1/confirmPreview.js`
- Modify: `backend/src/usecases/confirmPreviewUseCase.js`

**Interfaces:**
- Consumes: None
- Produces: Removed mask-regions endpoints

- [ ] **Step 1: Remove normalizeRegion import from dubData.js**

```javascript
// Change import from:
import { normalizeRegion } from '../../media/mediaService.js'

// Remove this import line entirely
```

- [ ] **Step 2: Remove GET /mask-regions endpoint from dubData.js**

```javascript
// Find and remove the entire GET /mask-regions endpoint (around lines 53-65):
// GET /api/v1/projects/:id/mask-regions — OcrRegion[] (AUTO từ OCR + MANUAL từ Canvas)
router.get('/projects/:id/mask-regions', requireProjectOwner, async (req, res) => {
  // ... entire endpoint
})
```

- [ ] **Step 3: Remove PUT /mask-regions endpoint from dubData.js**

```javascript
// Find and remove the entire PUT /mask-regions endpoint (around lines 196-256):
// PUT /api/v1/projects/:id/mask-regions — lưu vùng che sau khi user chỉnh trên Canvas.
router.put('/projects/:id/mask-regions', requireProjectOwner, async (req, res) => {
  // ... entire endpoint
})
```

- [ ] **Step 4: Remove NUM helper function from dubData.js**

```javascript
// Find and remove the NUM helper function (around lines 191-194):
const NUM = (v, fallback = 0) => {
  // ... entire function
}
```

- [ ] **Step 5: Simplify confirmPreviewUseCase.js**

```javascript
// Replace entire content of confirmPreviewUseCase.js:
import { queryOne, run } from '../db/query.js'

/**
 * ConfirmPreviewUseCase — FR-J2
 * Runs after dub.translate, before dub.ttsAlign/dub.render.
 */
export async function confirmPreviewUseCase(projectId) {
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  if (!project) throw new Error('Project not found')

  // Verify mode is TRANSLATE_DUB
  const mode = String(project.mode || '').toUpperCase().replace('-', '_')
  if (mode !== 'TRANSLATE_DUB') {
    const err = new Error('Confirm preview chỉ khả dụng cho project TRANSLATE_DUB')
    err.code = 'VALIDATION'
    throw err
  }

  // Check that dub.translate has completed
  const translateJob = await queryOne(
    `SELECT id, status FROM generation_jobs WHERE project_id = ? AND type = 'dub.translate'`,
    [projectId]
  )
  if (!translateJob || translateJob.status !== 'success') {
    const err = new Error('dub.translate chưa hoàn thành')
    err.code = 'VALIDATION'
    throw err
  }

  // Mark confirm preview step in params
  const params = project.params ? JSON.parse(project.params) : {}
  params.previewConfirmed = true
  params.previewConfirmedAt = new Date().toISOString()
  await run(`UPDATE projects SET params = ? WHERE id = ?`, [JSON.stringify(params), projectId])

  return { message: 'Preview confirmed, render queued', projectId }
}

export default confirmPreviewUseCase
```

- [ ] **Step 6: Update confirmPreview.js route**

```javascript
// Update the route to not pass regions parameter:
// Change from:
const result = await confirmPreviewUseCase(req.params.id, req.body.regions)

// Change to:
const result = await confirmPreviewUseCase(req.params.id)
```

- [ ] **Step 7: Run lint to verify**

```bash
cd backend && npm run lint
```

---

## Task 6: Backend - Delete dubOcr.js

**Files:**
- Delete: `backend/src/pipeline/stages/dubOcr.js`

**Interfaces:**
- Consumes: None
- Produces: File deleted

- [ ] **Step 1: Delete dubOcr.js file**

```bash
rm backend/src/pipeline/stages/dubOcr.js
```

- [ ] **Step 2: Verify no remaining imports**

```bash
grep -r "dubOcr" backend/src/
```

---

## Task 7: Frontend - Update constants.jsx

**Files:**
- Modify: `frontend/src/lib/constants.jsx`

**Interfaces:**
- Consumes: None
- Produces: Removed MASK_METHODS constant

- [ ] **Step 1: Remove MASK_METHODS constant**

```javascript
// Find and remove the entire MASK_METHODS constant (around lines 50-54):
export const MASK_METHODS = {
  blur: { label: 'Làm mờ', desc: 'Nhanh, rẻ — có thể còn vệt chữ lem' },
  fill: { label: 'Lấp màu nền', desc: 'Lấy màu nền quanh chữ lấp phẳng — mặc định' },
  inpaint: { label: 'AI Inpainting', desc: 'Tái tạo nền đẹp nhất — tốn tài nguyên nhất' },
};
```

- [ ] **Step 2: Run lint to verify**

```bash
cd frontend && npm run lint
```

---

## Task 8: Frontend - Update CreateProject.jsx

**Files:**
- Modify: `frontend/src/pages/CreateProject.jsx`

**Interfaces:**
- Consumes: None
- Produces: Wizard without maskMethod step

- [ ] **Step 1: Find and remove maskMethod wizard step**

```bash
grep -n "maskMethod\|Che chữ" frontend/src/pages/CreateProject.jsx
```

- [ ] **Step 2: Remove maskMethod step from wizard**

Look for the step that asks user to select maskMethod (blur/fill/inpaint) and remove it entirely.

- [ ] **Step 3: Remove maskMethod from form submission**

```bash
grep -n "maskMethod" frontend/src/pages/CreateProject.jsx
```

Remove any `maskMethod` field from the form data object.

- [ ] **Step 4: Run lint to verify**

```bash
cd frontend && npm run lint
```

---

## Task 9: Frontend - Update ProjectDetail.jsx

**Files:**
- Modify: `frontend/src/pages/ProjectDetail.jsx`

**Interfaces:**
- Consumes: None
- Produces: UI without SubRegionEditor and mask-related elements

- [ ] **Step 1: Remove SubRegionEditor import**

```javascript
// Find and remove this line (around line 6):
import SubRegionEditor from '@/components/SubRegionEditor';
```

- [ ] **Step 2: Remove MASK_METHODS import**

```javascript
// Find the import from constants and remove MASK_METHODS:
// Change from:
import { STAGE_LABELS, StatusBadge, formatDate, LANGUAGE_LABELS, STYLE_LABELS, VOICE_PROVIDER_LABELS, MODE_LABELS, MASK_METHODS, SOURCE_LANGUAGES, TARGET_LANGUAGES } from '@/lib/constants';

// Change to:
import { STAGE_LABELS, StatusBadge, formatDate, LANGUAGE_LABELS, STYLE_LABELS, VOICE_PROVIDER_LABELS, MODE_LABELS, SOURCE_LANGUAGES, TARGET_LANGUAGES } from '@/lib/constants';
```

- [ ] **Step 3: Remove global mask opacity slider**

```bash
grep -n "maskOpacity\|handleGlobalMaskOpacity\|maskStrength" frontend/src/pages/ProjectDetail.jsx
```

Remove the slider UI and related state/handler.

- [ ] **Step 4: Remove SubRegionEditor from compact mode (left panel)**

```javascript
// Find and remove the SubRegionEditor in compact mode (around line 567):
<SubRegionEditor
  videoUrl={videoUrl}
  regions={regions}
  onChange={setRegions}
  onSave={handleSaveRegions}
  saving={savingRegions}
  saveError={saveRegionError}
  compact
/>
```

- [ ] **Step 5: Remove SubRegionEditor from full mode**

```javascript
// Find and remove the SubRegionEditor in full mode (around line 881):
<SubRegionEditor
  videoUrl={videoUrl}
  regions={regions}
  onChange={setRegions}
  onSave={handleSaveRegions}
  saving={savingRegions}
  saveError={saveRegionError}
/>
```

- [ ] **Step 6: Remove maskMethod display**

```javascript
// Find and remove the maskMethod display (around line 497):
<span className="text-slate-400">{MASK_METHODS[params.maskMethod ?? params.mask_method]?.label || params.maskMethod || '—'}</span>
```

- [ ] **Step 7: Remove "Che chữ gốc" from summary list**

```javascript
// Find and remove this line (around line 978):
['Che chữ gốc', MASK_METHODS[params.maskMethod ?? params.mask_method]?.label || params.maskMethod || '—'],
```

- [ ] **Step 8: Remove regions state and handlers**

```bash
grep -n "regions\|setRegions\|handleSaveRegions\|savingRegions\|saveRegionError" frontend/src/pages/ProjectDetail.jsx | head -20
```

Remove all state declarations and handler functions related to regions.

- [ ] **Step 9: Run lint to verify**

```bash
cd frontend && npm run lint
```

---

## Task 10: Frontend - Update api/projects.js

**Files:**
- Modify: `frontend/src/api/projects.js`

**Interfaces:**
- Consumes: None
- Produces: Removed mask-regions API calls

- [ ] **Step 1: Remove getMaskRegions function**

```javascript
// Find and remove the getMaskRegions function:
getMaskRegions: (id) => api.get(`/projects/${id}/mask-regions`).then(r => r.data),
```

- [ ] **Step 2: Remove putMaskRegions function**

```javascript
// Find and remove the putMaskRegions function:
putMaskRegions: (id, regions) => api.put(`/projects/${id}/mask-regions`, { regions }).then(r => r.data),
```

- [ ] **Step 3: Run lint to verify**

```bash
cd frontend && npm run lint
```

---

## Task 11: Frontend - Delete SubRegionEditor.jsx

**Files:**
- Delete: `frontend/src/components/SubRegionEditor.jsx`

**Interfaces:**
- Consumes: None
- Produces: File deleted

- [ ] **Step 1: Delete SubRegionEditor.jsx file**

```bash
rm frontend/src/components/SubRegionEditor.jsx
```

- [ ] **Step 2: Verify no remaining imports**

```bash
grep -r "SubRegionEditor" frontend/src/
```

---

## Task 12: Frontend - Update Landing.jsx

**Files:**
- Modify: `frontend/src/pages/Landing.jsx`

**Interfaces:**
- Consumes: None
- Produces: Updated feature descriptions

- [ ] **Step 1: Update feature description**

```javascript
// Find and update the line that mentions OCR (around line 17):
{ num: '04', label: 'AI chạy pipeline tự động (STT + OCR song song)' },

// Change to:
{ num: '04', label: 'AI chạy pipeline tự động (STT → Translate → TTS)' },
```

- [ ] **Step 2: Update main description**

```javascript
// Find and update the line that mentions hardsub (around line 79):
Hai chế độ: <span className="text-slate-200">Review phim</span> (phim 2–3 tiếng → video review 20–30 phút) và <span className="text-slate-200">Dịch &amp; Lồng tiếng</span> (video nước ngoài có hardsub → phụ đề tiếng Việt theo 12 phong cách + giọng lồng AI). AI tự động tạo đầu ra — không cần tự edit.

// Change to:
Hai chế độ: <span className="text-slate-200">Review phim</span> (phim 2–3 tiếng → video review 20–30 phút) và <span className="text-slate-200">Dịch &amp; Lồng tiếng</span> (video nước ngoài → phụ đề tiếng Việt theo 13 phong cách + giọng lồng AI). AI tự động tạo đầu ra — không cần tự edit.
```

- [ ] **Step 3: Run lint to verify**

```bash
cd frontend && npm run lint
```

---

## Task 13: Documentation - Update pipeline docs

**Files:**
- Modify: `Video_AI_docs/docs/01_KIEN_TRUC_TONG_THE.md`
- Modify: `Video_AI_docs/docs/05_THIET_KE_PIPELINE_CHI_TIET.md`
- Modify: `Video_AI_docs/README.md`

**Interfaces:**
- Consumes: None
- Produces: Updated documentation

- [ ] **Step 1: Update 01_KIEN_TRUC_TONG_THE.md - pipeline diagram**

```markdown
// Find the TRANSLATE_DUB pipeline diagram (around line 86-99) and update:
### 3.2. Mode `TRANSLATE_DUB` (Dịch thuật & Lồng tiếng)

```
Video nước ngoài
   │
   ▼  [ingest]        resumable upload → demux (audio/video) → normalize LUFS
   ▼  [stt]           ASR → transcript(timestamp, speaker)
   ▼  [merge]         Kiểm tra barrier: transcript + translation + duration + language
   ▼  [translate]     LLM + StylePreset(13 phong cách) → bản dịch khớp context window
   ▼  [ttsAlign?]     TTS + Forced Alignment khớp slot gốc (tuỳ chọn enableDubbing)
   ▼  [render]        Burn-in sub mới → audio mix (dub voice + nền) → mux MP4/MKV (NVENC)
   ▼  [upload?]       YouTube
```
```

- [ ] **Step 2: Update 01_KIEN_TRUC_TONG_THE.md - remove OCR references**

Remove all references to OCR, maskMethod, and mask regions from this file.

- [ ] **Step 3: Update 05_THIET_KE_PIPELINE_CHI_TIET.md - remove OCR section**

```markdown
// Find and remove section B.3. Stage: ocr (phát hiện hardsub) entirely
```

- [ ] **Step 4: Update 05_THIET_KE_PIPELINE_CHI_TIET.md - update composite stage**

```markdown
// Find section B.6. Stage: composite — mask hardsub and update:
## B.6. Stage: render — Burn-in sub mới

- **Burn-in phụ đề mới**: file ASS có vị trí mặc định đáy khung hình →
  `media.burnSubtitlesStyled`.
- **Audio mixing** (xem `07_MODULE_FFMPEG.md` chi tiết):
  - **Dubbing bật**: thay voice gốc bằng dub track.
    - Giữ background (nhạc/tiếng động môi trường) nếu hệ thống tách stem được; ducking −12dB;
      `loudnorm` lần cuối.
  - **Dubbing tắt**: giữ nguyên audio gốc, chỉ thay phụ đề.
- **Muxing**: đóng gói video + audio mới thành MP4/MKV, ưu tiên tăng tốc phần cứng NVENC.
```

- [ ] **Step 5: Update README.md**

```markdown
// Find and update the table in section 1 (around line 15-19):
| `TRANSLATE_DUB` | **Dịch thuật & Lồng tiếng** | 1 video nước ngoài ≤ 2GB, chọn 1 trong **13 phong cách dịch** | Video giữ nguyên hình ảnh gốc, đã **dịch phụ đề tiếng Việt** + **giọng lồng AI ép khớp timestamp** (tuỳ chọn) |
```

- [ ] **Step 6: Verify all documentation changes**

```bash
grep -r "OCR\|maskMethod\|hardsub\|SubRegion" Video_AI_docs/
```

---

## Task 14: Final Verification

**Files:**
- All modified files

**Interfaces:**
- Consumes: All previous tasks
- Produces: Working system without OCR/maskMethod/manual timeline

- [ ] **Step 1: Run backend lint**

```bash
cd backend && npm run lint
```

- [ ] **Step 2: Run frontend lint**

```bash
cd frontend && npm run lint
```

- [ ] **Step 3: Run frontend build**

```bash
cd frontend && npm run build
```

- [ ] **Step 4: Test backend startup**

```bash
cd backend && timeout 5 npm run dev || true
```

- [ ] **Step 5: Verify no remaining references**

```bash
# Check backend
grep -r "dubOcr\|maskMethod\|maskRegions\|normalizeRegion" backend/src/

# Check frontend
grep -r "SubRegionEditor\|MASK_METHODS\|mask-regions\|getMaskRegions\|putMaskRegions" frontend/src/

# Check documentation
grep -r "OCR\|maskMethod" Video_AI_docs/
```

- [ ] **Step 6: Commit changes**

```bash
git add -A
git commit -m "feat: remove OCR stage, maskMethod, and manual timeline editing

- Remove dub.ocr from pipeline (runner.js)
- Remove mask regions API endpoints (dubData.js)
- Remove SubRegionEditor component
- Remove MASK_METHODS constant
- Simplify dubRender to only burn-in sub (no mask)
- Update dubMerge with additional checks (translation, duration, language)
- Update documentation to reflect new pipeline"
```

---

## Success Criteria

1. ✅ Pipeline TRANSLATE_DUB runs without OCR stage
2. ✅ dubMerge validates transcript + translation + duration + language
3. ✅ dubRender only burns-in sub (no mask regions)
4. ✅ Frontend has no maskMethod selection
5. ✅ Frontend has no SubRegionEditor
6. ✅ All API endpoints for mask-regions are removed
7. ✅ Documentation is updated
8. ✅ All lint checks pass
9. ✅ Frontend builds successfully
