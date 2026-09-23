# TRANSLATE_DUB Workflow Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the full TRANSLATE_DUB workflow (stale output, mask approve lifecycle, OCR consensus, transcript editing, realtime completion, timing) without rewriting architecture.

**Architecture:** Surgical changes only: gate output on `project.status`, add `ocr_regions.status` + `transcript_segments` manual-edit flags via ALTER migrations, render only APPROVED masks, skip manually-edited translations, normalize SSE `success→completed` with retry reload. No new dependencies, no destructive deletes, no commits (human decides).

**Tech Stack:** Node ESM Express + sql.js, React 18 + Vite 6, FFmpeg via mediaService.

**Spec:** This plan IS the spec (user brief 16 sections, 2026-09-23). Decisions locked: (1) backfill `MANUAL+enabled=1→APPROVED`, `enabled=0→DISABLED`, new masks default `DRAFT`; (2) PUT text-change with no translation in payload → `translation=NULL`, flags cleared so dub.translate re-translates; (3) verify via fixture + unit/integration (no live FFmpeg/Redis required).

## Global Constraints

- No `git commit/push/merge/reset` — humans decide.
- Never log secrets; never hard-code keys; never disable auth/CORS/validation.
- No destructive DB deletes; `clearArtifacts` must never touch `ocr_regions`.
- No new npm dependencies.
- Match existing code style; touch only what the task needs.
- Backend gate: `cd backend; npm test`. Frontend gate: `cd frontend; npm run lint` + `npm run build`.

---

### Task 1: DB migrations (mask status + manual-edit flags)

**Files:**
- Modify: `backend/src/db/schema.js`

**Interfaces:**
- Consumes: existing `initSchema()` ALTER pattern (`addCol` try/catch).
- Produces: `ocr_regions.status TEXT DEFAULT 'DRAFT'` with backfill; `transcript_segments.is_text_manually_edited/is_translation_manually_edited INTEGER DEFAULT 0`.

- [ ] **Step 1: Write the failing test** — new file `backend/tests/translateDubWorkflow.test.mjs` (skeleton first): assert `ocr_regions` has `status`, `transcript_segments` has both flags after `initSchema()` on tmp DB.

```js
// backend/tests/translateDubWorkflow.test.mjs (step 1: schema block only)
import path from 'node:path'
import os from 'node:os'
process.env.DB_PATH = path.join(os.tmpdir(), `vidai_workflow_${Date.now()}.db`)
const { initSchema } = await import('../src/db/schema.js')
const { query } = await import('../src/db/query.js')
await initSchema()
async function cols(table) {
  const rows = await query(`PRAGMA table_info(${table})`)
  return rows.map((r) => r.name)
}
const oc = await cols('ocr_regions')
console.log(oc.includes('status') ? 'PASS: ocr_regions.status' : 'FAIL: ocr_regions.status')
const tc = await cols('transcript_segments')
console.log(tc.includes('is_translation_manually_edited') ? 'PASS: flag' : 'FAIL: flag')
process.exit(oc.includes('status') && tc.includes('is_translation_manually_edited') ? 0 : 1)
```

- [ ] **Step 2: Run test to verify it fails** — Run: `node tests/translateDubWorkflow.test.mjs` (from `backend/`). Expected: FAIL (no `status` column).
- [ ] **Step 3: Write minimal implementation** — in `schema.js`: CREATE TABLE `ocr_regions` gains `status TEXT DEFAULT 'DRAFT'`; add `addCol('ocr_regions','status',"TEXT DEFAULT 'DRAFT'")` + backfill `UPDATE ocr_regions SET status='APPROVED' WHERE source='MANUAL' AND (enabled=1) AND (status IS NULL OR status='DRAFT')` — CAREFUL: backfill must only promote rows that predate the feature. Simplest correct: `UPDATE ocr_regions SET status = CASE WHEN source='MANUAL' AND enabled=0 THEN 'DISABLED' WHEN source='MANUAL' THEN 'APPROVED' ELSE 'DRAFT' END WHERE status IS NULL OR status = ''`. New rows default DRAFT via DEFAULT. Add `addCol('transcript_segments','is_text_manually_edited','INTEGER DEFAULT 0')` + `addCol('transcript_segments','is_translation_manually_edited','INTEGER DEFAULT 0')`.
- [ ] **Step 4: Run test to verify it passes** — Run: `node tests/translateDubWorkflow.test.mjs`. Expected: PASS.

### Task 2: Mask status API (DRAFT→APPROVED→DISABLED)

**Files:**
- Modify: `backend/src/routes/v1/masks.js`
- Test: extend `backend/tests/translateDubWorkflow.test.mjs`

**Interfaces:**
- Consumes: `validateMaskInput`, `toMaskJson`, `loadOwnedMask` (existing).
- Produces: wire field `status` (camelCase in/out, `status` column in DB); render reads APPROVED only (Task 5).

- [ ] **Step 1: Write failing test** — append block: `validateMaskInput({...valid, status:'APPROVED'})` ok; `status:'BOGUS'` rejected; partial `{status:'DISABLED'}` ok; `toMaskJson({status:'APPROVED',...})` echoes `status`.

```js
const { validateMaskInput, toMaskJson } = await import('../src/routes/v1/masks.js')
const ok = validateMaskInput({ ratioX:0.1,ratioY:0.7,ratioW:0.8,ratioH:0.2,startSec:1,endSec:3,status:'APPROVED' })
console.log(ok.ok && ok.value.status==='APPROVED' ? 'PASS: approve' : 'FAIL: approve')
const bad = validateMaskInput({ ratioX:0.1,ratioY:0.7,ratioW:0.8,ratioH:0.2,startSec:1,endSec:3,status:'BOGUS' })
console.log(!bad.ok && bad.field==='status' ? 'PASS: reject' : 'FAIL: reject')
```

- [ ] **Step 2: Run test, expect FAIL.**
- [ ] **Step 3: Implement** — `MASK_STATUSES=['DRAFT','APPROVED','DISABLED']`; full mode defaults `status='DRAFT'`; partial accepts `status`; `toMaskJson` emits `status: r.status || 'DRAFT'` (AUTO derived → `'APPROVED'`? No — AUTO rows are virtual; emit `status:'AUTO'`? Keep `source:'AUTO'` as discriminator, set virtual `status:'APPROVED'` so render filter is uniform). POST inserts `status: v.value.status`; PATCH maps `status` + syncs `enabled` (APPROVED→1, DISABLED→0, DRAFT leaves `enabled` as sent or 1).
- [ ] **Step 4: Run test, expect PASS.**

### Task 3: Output lifecycle gating (backend)

**Files:**
- Modify: `backend/src/routes/v1/projects.js` (`GET /:id`)
- Test: extend test file (DB + source-content assertions)

**Interfaces:**
- Consumes: `project.status`.
- Produces: `output: null` while `status IN ('pending','queued','running','generating')`; latest row otherwise. No DELETE.

- [ ] **Step 1: Write failing test** — assert source contains active-status guard:

```js
import fs from 'node:fs'
const src = fs.readFileSync(new URL('../src/routes/v1/projects.js', import.meta.url), 'utf8')
const hasGate = /pending.*queued.*running/.test(src) && src.includes('output = null')
console.log(hasGate ? 'PASS: output gate' : 'FAIL: output gate')
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** — after fetching `output`, add: `const ACTIVE = new Set(['pending','queued','running','generating']); const gatedOutput = project && ACTIVE.has(project.status) ? null : output;` return `output: gatedOutput`. Keep `jobs/timeline` untouched.
- [ ] **Step 4: Run, expect PASS.**

### Task 4: SSE vocabulary unification

**Files:**
- Modify: `backend/src/pipeline/runner.js` (2 emits), `backend/src/routes/v1/events.js` (done condition)
- Test: source-content assertions in test file

- [ ] **Step 1: Write failing test** — assert `runner.js` emits `__project__` with `'completed'` (not `'success'`) and `events.js` done-condition includes `'completed'`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** — `runner.js:662,669`: `status: done >= total ? 'completed' : 'running'` and final `status: 'completed'`. `events.js:25`: `['completed','success','failed'].includes(...)` (keep `success` for backward compat with in-flight clients).
- [ ] **Step 4: Run, expect PASS.**

### Task 5: Render APPROVED-only + timing clamp + verify

**Files:**
- Modify: `backend/src/pipeline/stages/dubRender.js`
- Test: DB-backed `loadSubtitleRegions` filter test + `alignEnd` clamp unit test

**Interfaces:**
- Consumes: `ocr_regions.status`, `normalizeRegion` (now preserves `status`).
- Produces: `loadSubtitleRegions` returns MANUAL rows only if `status==='APPROVED'` (+AUTO derived); `alignEnd(seg, regions, nextStartSec)` clamps; post-render throws `BLOCK_RENDER` if `finalInfo.durationSec` invalid.

- [ ] **Step 1: Write failing test**:

```js
const { normalizeRegion, alignEnd, loadSubtitleRegions } = await import('../src/pipeline/stages/dubRender.js')
// normalize keeps status
console.log(normalizeRegion({ ratio_x:0.1,ratio_y:0.7,ratio_w:0.8,ratio_h:0.2,start_sec:1,end_sec:3,status:'DRAFT' })?.status==='DRAFT' ? 'PASS' : 'FAIL')
// alignEnd clamps to next cue
const r = [{ ratioX:0.1,ratioY:0.7,ratioW:0.8,ratioH:0.2,start_sec:0,end_sec:5,enabled:1 }]
console.log(alignEnd({ start_sec:0,end_sec:4.5 }, r, 4.6) <= 4.6 ? 'PASS: clamp' : 'FAIL: clamp')
```

- [ ] **Step 2: Run, expect FAIL (clamp + status).**
- [ ] **Step 3: Implement** — `normalizeRegion` returns `status: ['DRAFT','APPROVED','DISABLED'].includes(r.status)?r.status:(r.source==='AUTO'?'APPROVED':'DRAFT')`; `loadSubtitleRegions` filters stored `.filter(s => s.status==='APPROVED' && s.enabled!==0)`; `pickRegion` unchanged (input already filtered) but keep `enabled` check; `buildAss` computes sorted segments, passes `nextStart` to `alignEnd(seg, regions, nextStart)`; `alignEnd` = `min(region-extended, nextStart-0.02)` when nextStart finite; post-render: `if (!Number(finalInfo.durationSec) || finalInfo.durationSec<=0) throw new Error('BLOCK_RENDER: ...')`.
- [ ] **Step 4: Run, expect PASS.**

### Task 6: Manual-edit source of truth (PUT + dubTranslate skip)

**Files:**
- Modify: `backend/src/routes/v1/dubData.js`, `backend/src/pipeline/stages/dubTranslate.js`
- Test: source-content + DB-behavior assertions

- [ ] **Step 1: Write failing test** — assert `dubData.js` handles `s.text` and sets `is_text_manually_edited`; assert `dubTranslate.js` references `is_translation_manually_edited`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** — PUT accepts `{id, text?, translation?, startSec?, endSec?}`: compare `text` change → if `translation` not in payload, set `translation=NULL, is_translation_manually_edited=0`; if provided, set + flag 1; always set `is_text_manually_edited=1` on text change. `dubTranslate.js`: `untranslated` filter excludes `is_translation_manually_edited`; `segmentsToTranslate` excludes flagged rows (they keep DB value); both update branches (`updateById ... {translation}`) skip flagged.
- [ ] **Step 4: Run, expect PASS.**

### Task 7: OCR consensus tuning + Gemini language hint

**Files:**
- Modify: `backend/src/pipeline/stages/dubOcr.js`, `backend/src/providers/vision/geminiVision.js`
- Test: `aggregateBoxes` still passes existing `ocrAggregate.test.mjs`; new assertion `OCR_MIN_FRAMES` env respected

- [ ] **Step 1: Write failing test** — `detectSubtitle` accepts `sourceLanguage` (function length/param check via source grep `sourceLanguage` in geminiVision.js); `dubOcr.js` defines `OCR_MIN_FRAMES`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** — `geminiVision.detectSubtitle({imagePath,width,height,sourceLanguage})`: append `Ngôn ngữ phụ đề kỳ vọng: X.` to prompt when explicit (not auto). `dubOcr.js`: `const OCR_MIN_FRAMES = () => Number(process.env.OCR_MIN_FRAMES || 2)`; emit gate uses it; comment documents OCR→original-pixels (mask-independent) + human-correction fallback. No provider change.
- [ ] **Step 4: Run new test + `node tests/ocrAggregate.test.mjs`, expect PASS.**

### Task 8: Frontend realtime completion (no infinite polling)

**Files:**
- Modify: `frontend/src/hooks/useJobEvents.js`, `frontend/src/pages/ProjectDetail.jsx`
- Test: `cd frontend; npm run lint` (no frontend test runner exists — do not invent one)

- [ ] **Step 1: Write failing check** — manual: `useJobEvents` normalizes `success→completed`; `ProjectDetail` reloads on `lastEvent.__project__` terminal with bounded retry.
- [ ] **Step 2: Implement `useJobEvents`** — in `applyEvent`, map `data.status==='success' && data.stage==='__project__'` → `'completed'`; add `es.addEventListener('done', ...)` → set `lastEvent({stage:'__project__',status:'completed'})`; keep one-way `sseAvailable=false` fallback (bounded, no infinite poll — existing 3s poll only when SSE dead).
- [ ] **Step 3: Implement `ProjectDetail`** — `isOutputAvailable = project?.status==='completed' && project?.output?.storage_key && project?.output?.status==='success'`; derive `outputUrl` from it; when `!isOutputAvailable && isActive` hide video/header actions, show progress + current stage label; effect on `lastEvent`: if terminal `completed/failed`, bounded retry reload (`load()` + `loadDubData()` + jobs via `load`, up to 3 attempts 800ms apart until `project.status` terminal or output id changes); success path swaps video src via existing `outputUrl` effect (no browser reload).
- [ ] **Step 4: Run `npm run lint`, expect clean.**

### Task 9: Transcript editor rewrite (no drag-and-drop)

**Files:**
- Modify: `frontend/src/pages/ProjectDetail.jsx` (`TranscriptEditor` compact + full)

- [ ] **Step 1: Remove** `draggable`, `onDragStart`, `dataTransfer`, `effectAllowed` (both branches).
- [ ] **Step 2: Add** per-segment `Original [textarea]`, `Translation [textarea]`, `Start [number]`, `End [number]`; validation `0<=start<end` + overlap vs neighbors (client-side pre-check, server `OVERLAP_CONFLICT` is authority); payload `{id, text?, translation?, startSec?, endSec?}`; dirty tracking across all four fields.
- [ ] **Step 3: Run `npm run lint`, expect clean.**

### Task 10: MaskEditor approve workflow

**Files:**
- Modify: `frontend/src/components/MaskEditor.jsx`

- [ ] **Step 1: Add** status badges (DRAFT/APPROVED/DISABLED), Approve button (disabled when no selection or selected is AUTO or already APPROVED), `handleApprove` → `patchMask(id,{status:'APPROVED'})`; toggle eye now sends DISABLED/APPROVED instead of bare `enabled`; new masks created DRAFT (rely on backend default; pass `status:'DRAFT'` explicitly).
- [ ] **Step 2: Run `npm run lint`, expect clean.**

### Task 11: Full verification

- [ ] **Step 1:** `cd backend; npm test` — all files PASS (including new `translateDubWorkflow.test.mjs`).
- [ ] **Step 2:** `cd frontend; npm run lint` clean.
- [ ] **Step 3:** `cd frontend; npm run build` success.
- [ ] **Step 4:** Behavior map to CASE A–M in final report; list anything unverifiable (no live FFmpeg/Redis/keys in this env) with ROOT CAUSE + limitation, no fake workaround.

## Self-Review

- Spec coverage: §1 output gate (T3+T8) ✓; §2 approve lifecycle (T1+T2+T10) ✓; §3 burn verify (T5) ✓; §4 persistence (RESETS untouched, T5) ✓; §5 OCR (T7) ✓; §6 OCR ignores mask (by construction — OCR reads source frames; documented in T7) ✓; §7 editor (T9) ✓; §8 source of truth (T6) ✓; §9 rerun uses edits (T6 + existing redub path) ✓; §10 realtime (T4+T8) ✓; §11 timing (T5 clamp) ✓; §12 cache (`?v=id` kept; output becomes current only after render insert) ✓; §13 contract (camelCase wire, snake DB, status both ways) ✓; §14 tests (T11) ✓.
- No placeholders: every step has exact code/SQL to write.
- Type consistency: `status` (ocr_regions TEXT), `is_*_manually_edited` (INTEGER 0/1), wire camelCase `startSec/endSec/ratioX…/blurRadius/status`, DB snake_case.
