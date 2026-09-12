# Remove Auto OCR Subtitle Blur — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the automatic OCR subtitle detection (`dub.ocr`) from the pipeline and use the existing `SubRegionEditor` for manual region creation only.

**Architecture:** The pipeline currently runs `dub.stt` and `dub.ocr` in parallel, then `dub.merge` gates on both. After this change, only `dub.stt` runs, `dub.merge` checks only transcript segments, and `dub.render` still applies manual mask regions from the `ocr_regions` table. The frontend `SubRegionEditor` already supports full manual region editing (add/delete/move/resize/blur control).

**Tech Stack:** Node.js/Express backend, React/Vite frontend, SQLite (sql.js), FFmpeg

**Spec:** This plan implements the user request to remove automatic subtitle blurring and keep manual SubRegionEditor controls.

## Global Constraints

- Backend: Node.js + Express + sql.js + BullMQ
- Frontend: React 18 + Vite + TailwindCSS + Radix UI
- Database: SQLite via sql.js (no migrations needed — `ocr_regions` table stays, just no AUTO source rows)
- All coordinates are ratio-based (0..1), scale-invariant
- Manual regions use `source='MANUAL'` and survive OCR re-runs

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/src/pipeline/runner.js` | Modify | Remove `dub.ocr` from pipeline stages, parallel runner, stage maps |
| `backend/src/pipeline/stages/dubMerge.js` | Modify | Remove OCR checks, only verify transcript segments |
| `backend/src/routes/v1/projects.js` | Modify | Remove `maskMethod` validation from project creation |
| `frontend/src/lib/constants.jsx` | Modify | Remove `dub.ocr` from `DUB_STAGES`, `STAGE_ORDER`, `STAGE_LABELS` |
| `frontend/src/pages/CreateProject.jsx` | Modify | Remove "Nâng cao" step (maskMethod selection) from wizard |
| `frontend/src/pages/ProjectDetail.jsx` | Verify | Confirm SubRegionEditor displays correctly without OCR |

---

### Task 1: Remove `dub.ocr` from Pipeline Runner

**Files:**
- Modify: `backend/src/pipeline/runner.js`

**Interfaces:**
- Consumes: none (standalone change)
- Produces: `STAGES.TRANSLATE_DUB` no longer includes `'dub.ocr'`; `startDubParallel` only runs `dub.stt`

- [ ] **Step 1: Remove `dub.ocr` import**

In `backend/src/pipeline/runner.js`, line 49, remove the import:
```javascript
// DELETE this line:
import dubOcr from './stages/dubOcr.js'
```

- [ ] **Step 2: Remove `dub.ocr` from STAGES.TRANSLATE_DUB**

In `runner.js`, line 129, change the parallel group from `['dub.stt', 'dub.ocr', 'dub.merge']` to `['dub.stt', 'dub.merge']`:
```javascript
TRANSLATE_DUB: [
  'dub.ingest',
  ['dub.stt', 'dub.merge'],  // was: ['dub.stt', 'dub.ocr', 'dub.merge']
  'dub.translate',
  'dub.ttsAlign',
  'dub.render',
],
```

- [ ] **Step 3: Remove `dub.ocr` from STAGE_IMPL**

In `runner.js`, line 152, delete:
```javascript
// DELETE this line:
'dub.ocr': dubOcr,
```

- [ ] **Step 4: Remove `dub.ocr` from STAGE_PROVIDER**

In `runner.js`, line 170, delete:
```javascript
// DELETE this line:
'dub.ocr': 'ocr',
```

- [ ] **Step 5: Remove `dub.ocr` from RESETS**

In `runner.js`, line 189, delete:
```javascript
// DELETE this line:
'dub.ocr': ['ocrRegions', 'outputs'],
```

- [ ] **Step 6: Simplify `startDubParallel` to only run `dub.stt`**

Replace the entire `startDubParallel` function (lines 57-111) with:

```javascript
async function startDubParallel(project, setProgress, results, signal) {
  const projectId = project.id
  await ensureStageJob(projectId, 'dub.stt')
  await ensureStageJob(projectId, 'dub.merge')

  // Only run dub.stt (no more dub.ocr)
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

  // Run dub.merge (checks DB for transcript segments)
  if (sttOk) {
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

  return false
}
```

- [ ] **Step 7: Verify no remaining references to `dub.ocr`**

Run: `grep -rn "dub.ocr\|dubOcr" backend/src/`
Expected: No matches (except possibly in `dubOcr.js` file itself which is now unused)

- [ ] **Step 8: Commit**

```bash
git add backend/src/pipeline/runner.js
git commit -m "feat: remove dub.ocr from pipeline runner"
```

---

### Task 2: Simplify `dubMerge` to Only Check Transcript

**Files:**
- Modify: `backend/src/pipeline/stages/dubMerge.js`

**Interfaces:**
- Consumes: `dub.stt` writes `transcript_segments` table
- Produces: `{ transcriptSegments: number }` — no longer requires OCR regions

- [ ] **Step 1: Replace `dubMerge.js` content**

Replace the entire file with:

```javascript
import { query } from '../../db/query.js'
import { logProviderCall } from '../../providers/tracked.js'

/**
 * dub.merge — Stage kiểm tra barrier
 * Chỉ chạy khi dub.stt đã SUCCESS
 * Kiểm tra TranscriptSegment có trong DB chưa
 */
export default async function dubMerge({ project, job, setProgress }) {
  const projectId = project.id

  setProgress(20)

  // Kiểm tra TranscriptSegment (từ dub.stt)
  const transcriptSegments = await query(
    'SELECT id FROM transcript_segments WHERE project_id = ? LIMIT 1',
    [projectId]
  )

  setProgress(60)

  if (transcriptSegments.length === 0) {
    throw new Error('Thiếu TranscriptSegment từ dub.stt')
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
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/pipeline/stages/dubMerge.js
git commit -m "feat: simplify dubMerge to only check transcript segments"
```

---

### Task 3: Remove `maskMethod` Validation from Project Creation

**Files:**
- Modify: `backend/src/routes/v1/projects.js`

**Interfaces:**
- Consumes: POST body with optional `maskMethod`
- Produces: Projects created without `maskMethod` in params (user sets it manually via SubRegionEditor)

- [ ] **Step 1: Remove `maskMethod` validation block**

In `projects.js`, lines 63-65, remove the maskMethod validation:
```javascript
// DELETE these lines:
const maskMethod = b.maskMethod || params.maskMethod || 'fill'
if (!MASK_METHODS.includes(maskMethod)) {
  return sendError(res, 400, ERR.VALIDATION, `maskMethod must be one of ${MASK_METHODS.join(', ')}`, { field: 'maskMethod' })
}
```

- [ ] **Step 2: Remove `params.maskMethod = maskMethod` assignment**

In `projects.js`, line 84, delete:
```javascript
// DELETE this line:
params.maskMethod = maskMethod
```

- [ ] **Step 3: Remove `MASK_METHODS` constant**

In `projects.js`, line 18, delete:
```javascript
// DELETE this line:
const MASK_METHODS = ['blur', 'fill', 'inpaint']
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/v1/projects.js
git commit -m "feat: remove maskMethod validation from project creation"
```

---

### Task 4: Remove `dub.ocr` from Frontend Constants

**Files:**
- Modify: `frontend/src/lib/constants.jsx`

**Interfaces:**
- Consumes: none
- Produces: `DUB_STAGES`, `STAGE_ORDER`, `STAGE_LABELS` no longer include `dub.ocr`

- [ ] **Step 1: Remove `dub.ocr` from STAGE_LABELS**

In `constants.jsx`, line 30, delete:
```javascript
// DELETE this line:
'dub.ocr': { label: 'Quét phụ đề cứng (OCR)', icon: 'ScanText' },
```

- [ ] **Step 2: Remove `dub.ocr` from STAGE_ORDER**

In `constants.jsx`, line 38, remove `'dub.ocr'` from the array:
```javascript
// CHANGE from:
...['dub.ingest', 'dub.stt', 'dub.ocr', 'dub.translate', 'dub.ttsAlign', 'dub.render'],
// TO:
...['dub.ingest', 'dub.stt', 'dub.translate', 'dub.ttsAlign', 'dub.render'],
```

- [ ] **Step 3: Remove `dub.ocr` from DUB_STAGES**

In `constants.jsx`, line 49, remove `'dub.ocr'`:
```javascript
// CHANGE from:
export const DUB_STAGES = ['dub.ingest', 'dub.stt', 'dub.ocr', 'dub.translate', 'dub.ttsAlign', 'dub.render'];
// TO:
export const DUB_STAGES = ['dub.ingest', 'dub.stt', 'dub.translate', 'dub.ttsAlign', 'dub.render'];
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/constants.jsx
git commit -m "feat: remove dub.ocr from frontend constants"
```

---

### Task 5: Remove "Nâng Cao" Step from CreateProject Wizard

**Files:**
- Modify: `frontend/src/pages/CreateProject.jsx`

**Interfaces:**
- Consumes: `MASK_METHODS` from constants (no longer used in wizard)
- Produces: Wizard has 5 steps instead of 6 for TRANSLATE_DUB mode

- [ ] **Step 1: Remove `MASK_METHODS` import**

In `CreateProject.jsx`, line 7, remove `MASK_METHODS` from the import:
```javascript
// CHANGE from:
import {
  LANGUAGE_LABELS, STYLE_LABELS, VOICE_PROVIDER_LABELS,
  MODE_LABELS, MASK_METHODS, SOURCE_LANGUAGES, TARGET_LANGUAGES,
  STYLE_PRESETS_FALLBACK,
} from '@/lib/constants';
// TO:
import {
  LANGUAGE_LABELS, STYLE_LABELS, VOICE_PROVIDER_LABELS,
  MODE_LABELS, SOURCE_LANGUAGES, TARGET_LANGUAGES,
  STYLE_PRESETS_FALLBACK,
} from '@/lib/constants';
```

- [ ] **Step 2: Remove "Nâng cao" step from `dubSteps`**

In `CreateProject.jsx`, lines 81-88, remove the `advanced` step:
```javascript
// CHANGE from:
const dubSteps = [
  { key: 'video', label: 'Video', icon: Film },
  { key: 'language', label: 'Ngôn ngữ', icon: Globe },
  { key: 'preset', label: 'Phong cách dịch', icon: Languages },
  { key: 'dubbing', label: 'Lồng tiếng AI', icon: Mic },
  { key: 'advanced', label: 'Nâng cao', icon: Eraser },
  { key: 'generate', label: 'Tạo', icon: Wand2 },
];
// TO:
const dubSteps = [
  { key: 'video', label: 'Video', icon: Film },
  { key: 'language', label: 'Ngôn ngữ', icon: Globe },
  { key: 'preset', label: 'Phong cách dịch', icon: Languages },
  { key: 'dubbing', label: 'Lồng tiếng AI', icon: Mic },
  { key: 'generate', label: 'Tạo', icon: Wand2 },
];
```

- [ ] **Step 3: Remove step 4 validation from `canNext()`**

In `CreateProject.jsx`, line 140, delete:
```javascript
// DELETE this line:
if (step === 4) return !!form.maskMethod;
```

- [ ] **Step 4: Remove the "Nâng cao" step JSX block**

In `CreateProject.jsx`, lines 361-387, delete the entire block:
```jsx
{/* TRANSLATE_DUB: nâng cao — method che chữ + vị trí phụ đề mới */}
{isDub && step === 4 && (
  <div>
    <label className="text-sm font-medium text-slate-300 mb-2 block">Cách xử lý phụ đề gốc (hardsub)</label>
    <div className="space-y-3">
      {Object.entries(MASK_METHODS).map(([code, m]) => (
        <OptionCard key={code} selected={form.maskMethod === code} onClick={() => update('maskMethod', code)} title={m.label} desc={m.desc} />
      ))}
    </div>

    <label className="text-sm font-medium text-slate-300 mt-5 mb-2 block">Vị trí phụ đề dịch mới</label>
    <select
      value={form.subPosition}
      onChange={(e) => update('subPosition', e.target.value)}
      className="w-full px-3 py-2.5 rounded-lg bg-[#0F1117] border border-white/10 text-slate-200 focus:outline-none focus:border-blue-500/50">
      <option value="original">Đè lên vùng đã che (trùng khớp hardsub gốc)</option>
      <option value="top">Phía trên (safe zone trên)</option>
      <option value="bottom">Phía dưới (safe zone dưới)</option>
      <option value="custom">Tuỳ chỉnh (để trống — chỉnh sau trên editor)</option>
    </select>

    <p className="text-xs text-slate-500 mt-3 leading-relaxed">
      Mặc định phụ đề dịch đè lên vùng đã che để thẩm mỹ. Sau khi pipeline quét OCR xong, bạn có thể
      chỉnh vùng che, độ mờ và vị trí ngay trên trang chi tiết dự án.
    </p>
  </div>
)}
```

- [ ] **Step 5: Update Generate step index check**

In `CreateProject.jsx`, line 390, change the step comparison since generate is now step 4 (was step 5):
```javascript
// CHANGE from:
{(form.mode === 'SUMMARY' && step === 5) || (isDub && step === 5) ? (
// TO:
{(form.mode === 'SUMMARY' && step === 5) || (isDub && step === 4) ? (
```

- [ ] **Step 6: Remove `Eraser` import (no longer used)**

In `CreateProject.jsx`, line 4, remove `Eraser` from the lucide-react import:
```javascript
// CHANGE from:
import { Check, ChevronRight, ChevronLeft, Globe, Clock, Palette, Mic, Wand2, Loader2, Upload, Film, Clapperboard, Languages, AlertCircle, AudioLines, Eraser, AlertTriangle } from 'lucide-react';
// TO:
import { Check, ChevronRight, ChevronLeft, Globe, Clock, Palette, Mic, Wand2, Loader2, Upload, Film, Clapperboard, Languages, AlertCircle, AudioLines, AlertTriangle } from 'lucide-react';
```

- [ ] **Step 7: Remove `maskMethod` and `maskStrength` from form defaults**

In `CreateProject.jsx`, lines 66-67, delete:
```javascript
// DELETE these lines:
maskMethod: 'fill',
maskStrength: 0.6,
```

- [ ] **Step 8: Remove `maskMethod` and `maskStrength` from payload**

In `CreateProject.jsx`, lines 169-170, delete:
```javascript
// DELETE these lines:
maskMethod: form.maskMethod,
maskStrength: Number(form.maskStrength) || 0.6,
```

- [ ] **Step 9: Remove "Che chữ gốc" from summary display**

In `CreateProject.jsx`, line 425, delete:
```javascript
// DELETE this line:
['Che chữ gốc', MASK_METHODS[form.maskMethod]?.label],
```

- [ ] **Step 10: Update description text about OCR**

In `CreateProject.jsx`, line 206, update the mode card description:
```javascript
// CHANGE from:
desc="Tải video nước ngoài có phụ đề cứng, AI quét OCR + dịch tiếng Việt theo 12 phong cách, tuỳ chọn lồng giọng AI — giữ nguyên hình ảnh gốc."
// TO:
desc="Tải video nước ngoài có phụ đề cứng, dịch tiếng Việt theo 12 phong cách, tuỳ chọn lồng giọng AI — giữ nguyên hình ảnh gốc. Bạn tự khoanh vùng che phụ đề trên editor."
```

- [ ] **Step 11: Commit**

```bash
git add frontend/src/pages/CreateProject.jsx
git commit -m "feat: remove maskMethod wizard step from CreateProject"
```

---

### Task 6: Verify SubRegionEditor Works Without OCR

**Files:**
- Verify: `frontend/src/pages/ProjectDetail.jsx`
- Verify: `frontend/src/components/SubRegionEditor.jsx`

**Interfaces:**
- SubRegionEditor receives `regions` prop (manual only) and `onChange`/`onSave` callbacks

- [ ] **Step 1: Check ProjectDetail.jsx for OCR-dependent code**

Search `ProjectDetail.jsx` for references to `dub.ocr`, `ocr`, `AUTO` source. The SubRegionEditor should work with empty regions (user creates them manually).

Run: `grep -n "dub.ocr\|ocr\|AUTO" frontend/src/pages/ProjectDetail.jsx`
Expected: Only references in SSE event handling (harmless — just won't receive `dub.ocr` events anymore)

- [ ] **Step 2: Build frontend to verify no compilation errors**

Run: `cd frontend && npm run build`
Expected: Build succeeds with no errors

- [ ] **Step 3: Build backend to verify no compilation errors**

Run: `cd backend && npm run build` (if build script exists) or `node -e "import('./src/pipeline/runner.js')"`
Expected: No import errors

- [ ] **Step 4: Commit (if any changes needed)**

```bash
git add -A
git commit -m "chore: verify SubRegionEditor works without OCR"
```

---

### Task 7: Lint and Final Verification

- [ ] **Step 1: Run frontend lint**

Run: `cd frontend && npm run lint`
Expected: No errors

- [ ] **Step 2: Run frontend build**

Run: `cd frontend && npm run build`
Expected: Build succeeds

- [ ] **Step 3: Run backend lint (if available)**

Run: `cd backend && npm run lint` (if script exists)
Expected: No errors

- [ ] **Step 4: Verify pipeline stages are correct**

Run: `grep -n "TRANSLATE_DUB" backend/src/pipeline/runner.js`
Expected: Only `['dub.stt', 'dub.merge']` in parallel group (no `dub.ocr`)

- [ ] **Step 5: Final commit if any lint fixes needed**

```bash
git add -A
git commit -m "chore: lint fixes after removing auto OCR"
```
