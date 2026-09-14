# Video-AI Pipeline Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix OCR → translation → TTS → render so final video uses accurate subtitles, correct per-segment audio, no overlap, and hard BLOCK_RENDER on invalid data.

**Architecture:** Surgical hardening of existing stages/providers with pure helpers (fuzzy/bbox/validation/timeline), ID-keyed audio mapping, physical probe-after-trim, deterministic no-overlap scheduler. No new deps, no schema change, no arch rewrite.

**Tech Stack:** Node.js ESM, SQLite sql.js, FFmpeg/ffprobe, Tesseract.js, existing provider registry + callProvider.

**Spec:** Chat-approved plan 2026-09-14 (2 FPS default+env, hard BLOCK_RENDER, heuristics+LLM retry, no schema change). Root causes in `backend/src/pipeline/stages/dubOcr.js`, `tesseractOcr.js`, `dubTranslate.js`, `dubTtsAlign.js`, `forcedAlignService.js`, `dubRender.js`, `media/mediaService.js`, `dubMerge.js`.

## Global Constraints

- JavaScript ESM only, no TypeScript.
- No new npm dependencies.
- No DB schema migration; reuse `transcript_segments`/`audios` + stage results.
- Preserve ASR mode, OCR mode, dub-off mode, provider registry, pipeline runner.
- Surgical diffs only; match existing style.
- Never use array index or sorted filename as segment/audio identity.
- Hard BLOCK_RENDER on missing/invalid required artifacts; no silent fallback to another segment's audio.
- Physical audio duration must match placement (probe with FFmpeg); metadata-only clipping is forbidden.
- `OCR_FPS` default 2, `OCR_CAP` default 900, `OCR_MIN_CONF` default 0.55, all env-overridable.

---

### Task 1: OCR aggregation + timing (dubOcr.js)

**Files:**
- Modify: `backend/src/pipeline/stages/dubOcr.js`
- Test: `backend/tests/ocrAggregate.test.mjs`

**Interfaces:**
- Consumes: `sampleFrames`, OCR provider `detectSubtitle`, video `durationSec`.
- Produces: exported pure helpers `normalizeText(t)`, `textSim(a,b)`, `bboxCompatible(a,b,h)`, `aggregateBoxes(boxes,durationSec,fps)` preserving `{id,project_id,index_num,start_sec,end_sec,text,speaker,language}` + confidence used internally for gating.

- [ ] **Step 1: Write failing test** `backend/tests/ocrAggregate.test.mjs` importing helpers from `dubOcr.js`; cases: fuzzy grouping ("Hello world" vs "hello  world!"), majority vote over noisy frame, singleton rejection, end timing uses fps step not +1 blind, bounds clamp, duplicate merge.

```js
import { aggregateBoxes, textSim } from '../src/pipeline/stages/dubOcr.js'
const boxes = [
  { text: 'Hello world', confidence: 0.9, timestamp: 1.0, y: 600, height: 40, x: 100, width: 400 },
  { text: 'hello  world!', confidence: 0.85, timestamp: 1.5, y: 602, height: 40, x: 102, width: 398 },
  { text: 'WATERMARK TV', confidence: 0.9, timestamp: 1.5, y: 50, height: 20, x: 10, width: 100 },
]
const segs = aggregateBoxes(boxes, 100, 2)
if (!(segs.length === 1 && /hello/i.test(segs[0].text))) { console.error('FAIL ocr aggregate'); process.exit(1) }
if (!(textSim('Hello world', 'hello  world!') >= 0.82)) { console.error('FAIL textSim'); process.exit(1) }
console.log('PASS ocrAggregate'); process.exit(0)
```

- [ ] **Step 2: Run test, verify FAIL** Run: `node backend/tests/ocrAggregate.test.mjs` Expected: FAIL (helpers not exported / logic missing).
- [ ] **Step 3: Implement in dubOcr.js** Change `sampleFrames(src,framesDir,{fps:Number(process.env.OCR_FPS||2),cap:Number(process.env.OCR_CAP||900)})`; add `textSim` (token Jaccard + normalized Levenshtein ≥0.82), `bboxCompatible` (same bottom band, y-drift <8% h, x-overlap>0.3); group if `dt≤1.2 && textSim && bbox`; majority vote; require frames≥2, span≥0.8s, avgConf≥`OCR_MIN_CONF`; `endSec=min(max+1/fps,durationSec)`; clamp/ordering/dedup; export helpers.
- [ ] **Step 4: Run test, verify PASS** Run: `node backend/tests/ocrAggregate.test.mjs` Expected: PASS. Also run: `node backend/tests/dubMerge.test.mjs` Expected: PASS (no regression).
- [ ] **Step 5: Commit** `git add backend/src/pipeline/stages/dubOcr.js backend/tests/ocrAggregate.test.mjs` `git commit -m "fix(ocr): fuzzy temporal aggregation with bbox gate and timing"`

### Task 2: Tesseract ROI filtering (tesseractOcr.js)

**Files:**
- Modify: `backend/src/providers/vision/tesseractOcr.js`
- Test: `backend/tests/tesseractFilter.test.mjs`

**Interfaces:**
- Consumes: env `OCR_BOTTOM_RATIO` (default 0.6), `OCR_PSM` (6), `OCR_MIN_BOX_CONF` (0.35), `OCR_MIN_HEIGHT_RATIO` (0.012).
- Produces: same contract `{boxes:[{x,y,width,height,text,confidence}],model,usage}` with filtered, scale-independent coords.

- [ ] **Step 1: Write failing test** asserting bottom-band + min-height + min-conf filtering and `y+cropY` restore via exported `filterBoxes(boxes,{width,height})` or via mocked worker is hard — test pure filter if exported, else test `mapLanguage` + filter helper.

```js
import { filterSubtitleBoxes } from '../src/providers/vision/tesseractOcr.js'
const out = filterSubtitleBoxes([
  { x: 10, y: 10, width: 100, height: 12, text: 'LOGO', confidence: 0.95 },
  { x: 100, y: 650, width: 400, height: 30, text: 'Xin chào', confidence: 0.8 },
], { width: 1280, height: 720 })
if (!(out.length === 1 && out[0].text === 'Xin chào')) { console.error('FAIL filter'); process.exit(1) }
console.log('PASS tesseractFilter'); process.exit(0)
```

- [ ] **Step 2: Run test, verify FAIL** Run: `node backend/tests/tesseractFilter.test.mjs` Expected: FAIL (export missing).
- [ ] **Step 3: Implement** Export `filterSubtitleBoxes`; call it in `detectSubtitle` after OCR; keep lang map, ROI crop, `y+cropY`, confidence `/100`; drop top-band/small/low-conf boxes.
- [ ] **Step 4: Run test, verify PASS** Run: `node backend/tests/tesseractFilter.test.mjs` Expected: PASS.
- [ ] **Step 5: Commit** `git add backend/src/providers/vision/tesseractOcr.js backend/tests/tesseractFilter.test.mjs` `git commit -m "fix(ocr): ROI/bbox/confidence filtering keeps contract"`

### Task 3: Translation context + semantic gate (dubTranslate.js)

**Files:**
- Modify: `backend/src/pipeline/stages/dubTranslate.js`
- Test: `backend/tests/translateValidate.test.mjs`

**Interfaces:**
- Consumes: segments with `text`, GT provider, optional LLM.
- Produces: exported `validateTranslation(src,tgt,targetLang)` returning `{ok,errors[]}`; `buildContextPrompt` includes prev/curr/next source.

- [ ] **Step 1: Write failing test** numbers/negation/entities/question/lang checks.

```js
import { validateTranslation } from '../src/pipeline/stages/dubTranslate.js'
const bad = validateTranslation('I have 2 apples, do you not want one?', 'Tôi có 3 quả táo.', 'vi')
const good = validateTranslation('I have 2 apples, do you not want one?', 'Tôi có 2 quả táo, bạn không muốn một quả sao?', 'vi')
if (bad.ok || !good.ok) { console.error('FAIL semantic', bad, good); process.exit(1) }
console.log('PASS translateValidate'); process.exit(0)
```

- [ ] **Step 2: Run test, verify FAIL** Run: `node backend/tests/translateValidate.test.mjs` Expected: FAIL.
- [ ] **Step 3: Implement** Add `validateTranslation` (non-empty, digit-set equality, negation lexicon en/vi, `?` intent, Latin entity overlap ≥0.5, target-lang check, length ratio 0.4–2.5); GT loop passes `{prev,curr,next}` context hint where provider supports it, else include in LLM restyle/ retry prompt; heuristic fail → 1 LLM retry with strict “preserve meaning” prompt → still fail → skip segment (no hallucinated translation); export helper.
- [ ] **Step 4: Run test, verify PASS** Run: `node backend/tests/translateValidate.test.mjs` + `node backend/tests/dubTranslate.backfill.test.mjs` Expected: PASS both.
- [ ] **Step 5: Commit** `git add backend/src/pipeline/stages/dubTranslate.js backend/tests/translateValidate.test.mjs` `git commit -m "fix(translate): context-aware translation with semantic gate"`

### Task 4: TTS ID mapping + physical fit (dubTtsAlign.js + forcedAlignService.js)

**Files:**
- Modify: `backend/src/pipeline/stages/dubTtsAlign.js`, `backend/src/pipeline/forcedAlignService.js`
- Test: `backend/tests/ttsMapping.test.mjs`, `backend/tests/physicalAudio.test.mjs`

**Interfaces:**
- Consumes: segments with translation, TTS provider, `fitSegment`, `placeSegments`, `probe`, `applyTempoAudio`.
- Produces: `alignments:[{segmentId,audioId,startAtSec,endAtSec,action,tempo}]` with `file` keyed by `segmentId`; exported `validateNoOverlap(timeline)` from `forcedAlignService.js`.

- [ ] **Step 1: Write failing tests** ID mapping survives partial failure; overlap validator rejects `A[5,8] B[7,…]`.

```js
import { validateNoOverlap } from '../src/pipeline/forcedAlignService.js'
const r = validateNoOverlap([{ segmentId: 'a', startAtSec: 5, endAtSec: 8 }, { segmentId: 'b', startAtSec: 7, endAtSec: 9 }])
if (r.ok) { console.error('FAIL overlap not caught'); process.exit(1) }
console.log('PASS physicalAudio validator'); process.exit(0)
```

- [ ] **Step 2: Run, verify FAIL** Run both test files. Expected: FAIL (validator missing; mapping test needs stage refactor).
- [ ] **Step 3: Implement** Filenames `seg_<segmentId>.mp3/wav` (sanitized); `fitted` map keyed by `segmentId`; after `applyTempoAudio` probe file, `atrim` if over slot+0.08, re-probe, set `durationSec` from probe; `placeSegments` by ID; assert `probedDur ≤ slot+0.08` else fail segment; add `validateNoOverlap` pure export.
- [ ] **Step 4: Run, verify PASS** Run new tests + `node backend/tests/callProvider.cacheArtifacts.test.mjs` Expected: PASS.
- [ ] **Step 5: Commit** `git add backend/src/pipeline/stages/dubTtsAlign.js backend/src/pipeline/forcedAlignService.js backend/tests/ttsMapping.test.mjs backend/tests/physicalAudio.test.mjs` `git commit -m "fix(tts): id-keyed audio with physical probe and no-overlap"`

### Task 5: Render ID resolve + overlap guard + BLOCK_RENDER (dubRender.js, mediaService.js, dubMerge.js)

**Files:**
- Modify: `backend/src/pipeline/stages/dubRender.js`, `backend/src/media/mediaService.js`, `backend/src/pipeline/stages/dubMerge.js`
- Test: `backend/tests/renderBlock.test.mjs`, `backend/tests/e2ePartialMapping.test.mjs`

**Interfaces:**
- Consumes: `transcript_segments` + `audios` + `dub.ttsAlign.alignments` + files on disk + video `durationSec`.
- Produces: `dubRender` throws `BLOCK_RENDER: <code>` on missing/duplicate/invalid/overlap; `buildDubTrack` throws `OVERLAP` on `startAtSec < prevEndAtSec - 0.05` or `dur > slot+0.08`.

- [ ] **Step 1: Write failing tests** S0 ok/S1 fail/S2 ok mapping: resolver must return file0 for S0, null for S1, file2 for S2 (never file1-shift); renderBlock: missing audio, duplicate audioId, invalid timing, overlap → all block; full-valid passes.

```js
import { resolveAudioEntries } from '../src/pipeline/stages/dubRender.js'
const rows = [{ id: 's0', start_sec: 0, end_sec: 2, audio_id: 'a0' }, { id: 's1', start_sec: 2, end_sec: 4, audio_id: null }, { id: 's2', start_sec: 4, end_sec: 6, audio_id: 'a2' }]
const aligns = [{ segmentId: 's0', audioId: 'a0', startAtSec: 0, endAtSec: 2 }, { segmentId: 's2', audioId: 'a2', startAtSec: 4, endAtSec: 6 }]
const filesById = new Map([['a0', '/tmp/a0.wav'], ['a2', '/tmp/a2.wav']])
const entries = resolveAudioEntries(rows, aligns, filesById)
if (!(entries.get('s0') === '/tmp/a0.wav' && !entries.get('s1') && entries.get('s2') === '/tmp/a2.wav')) { console.error('FAIL mapping'); process.exit(1) }
console.log('PASS e2ePartialMapping'); process.exit(0)
```

- [ ] **Step 2: Run, verify FAIL** Run both files. Expected: FAIL (resolver missing).
- [ ] **Step 3: Implement** Export `resolveAudioEntries(rows,aligns,filesById)` used by `dubRender`; remove `files[i]` logic; `validateForRender` adds OCR/translation/TTS/file/1:1/overlap/bounds checks using `probe` for file duration and `validateTranslation`/`validateNoOverlap` helpers; `buildDubTrack` pre-probes entries and validates ordering before ffmpeg.
- [ ] **Step 4: Run, verify PASS** Run new tests + `dubMerge.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `git add backend/src/pipeline/stages/dubRender.js backend/src/media/mediaService.js backend/src/pipeline/stages/dubMerge.js backend/tests/renderBlock.test.mjs backend/tests/e2ePartialMapping.test.mjs` `git commit -m "fix(render): id-keyed audio with overlap guard and BLOCK_RENDER"`
