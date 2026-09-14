# OCR Hard-Subtitle Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-implement OCR as an optional pipeline stage that replaces ASR for videos with hardcoded subtitles, with proper language mapping, ROI cropping, and temporal aggregation.

**Architecture:** Add `dub.ocr` as an optional stage that replaces `dub.stt` when the user enables OCR mode at project creation. OCR text is written to `transcript_segments.text` so the rest of the pipeline (translate → TTS → render) works unchanged. The TesseractOcr provider is improved with language mapping from `project.sourceLanguage`, subtitle ROI cropping, and image preprocessing.

**Tech Stack:** Tesseract.js (local OCR), ffmpeg (frame extraction), existing pipeline infrastructure

**Spec:** N/A (design approved inline via brainstorming)

## Global Constraints

- No database schema changes
- Preserve existing ASR pipeline behavior when OCR is disabled
- OCR text goes to `transcript_segments.text` (same as ASR)
- Language derived from `project.params.sourceLanguage`
- No new npm dependencies (tesseract.js already installed)

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `backend/src/providers/vision/tesseractOcr.js` | Modify | Add language mapping, ROI cropping, image preprocessing |
| `backend/src/pipeline/stages/dubOcr.js` | Create | New pipeline stage: frame extraction → OCR → aggregation → transcript_segments |
| `backend/src/pipeline/runner.js` | Modify | Conditional OCR/ASR stage selection based on `params.ocrMode` |
| `backend/src/routes/v1/projects.js` | Modify | Accept `ocrMode` parameter in project creation |
| `frontend/src/pages/CreateProject.jsx` | Modify | Add OCR mode toggle in TRANSLATE_DUB wizard |
| `frontend/src/lib/constants.jsx` | Modify | Add `dub.ocr` stage label |

---

### Task 1: Improve TesseractOcr Provider — Language Mapping & ROI Cropping

**Files:**
- Modify: `backend/src/providers/vision/tesseractOcr.js`

**Interfaces:**
- Consumes: `{ imagePath, width, height, sourceLanguage? }` (new optional param)
- Produces: `{ boxes: [{x, y, width, height, text, confidence}], model, usage }` (unchanged shape)

- [ ] **Step 1: Add language mapping function**

Add a `mapLanguage` function at the top of the file (after imports) that maps application language codes to Tesseract traineddata names:

```javascript
const LANG_MAP = {
  en: 'eng',
  ja: 'jpn',
  ko: 'kor',
  zh: 'chi_sim',
  'zh-TW': 'chi_tra',
  vi: 'vie',
  fr: 'fra',
  de: 'deu',
  es: 'spa',
}

function mapLanguage(sourceLanguage) {
  if (!sourceLanguage || sourceLanguage === 'auto') return ['eng']
  const code = sourceLanguage.trim()
  if (code.includes('+')) {
    return code.split('+').map(c => LANG_MAP[c] || c).filter(Boolean)
  }
  const mapped = LANG_MAP[code]
  return mapped ? [mapped] : [code]
}
```

- [ ] **Step 2: Add ROI cropping function**

Add a `cropSubtitleROI` function that uses ffmpeg to crop the bottom portion of the frame before OCR:

```javascript
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function cropSubtitleROI(imagePath, width, height, bottomRatio = 0.4) {
  const cropHeight = Math.round(height * bottomRatio)
  const cropY = height - cropHeight
  const outPath = imagePath.replace(/\.jpg$/i, '_crop.jpg')
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', imagePath,
      '-vf', `crop=${width}:${cropHeight}:0:${cropY}`,
      '-q:v', '3',
      outPath,
    ])
    return { croppedPath: outPath, cropY, cropHeight }
  } catch {
    return { croppedPath: imagePath, cropY: 0, cropHeight: height }
  }
}
```

- [ ] **Step 3: Add image preprocessing function**

Add a `preprocessImage` function that applies grayscale + contrast enhancement:

```javascript
async function preprocessImage(imagePath) {
  const outPath = imagePath.replace(/\.jpg$/i, '_pre.jpg')
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', imagePath,
      '-vf', 'eq=contrast=1.3:brightness=0.05,format=gray',
      '-q:v', '3',
      outPath,
    ])
    return outPath
  } catch {
    return imagePath
  }
}
```

- [ ] **Step 4: Update `detectSubtitle` to use language mapping and ROI cropping**

Replace the current `detectSubtitle` method. The key changes:
1. Accept `sourceLanguage` parameter
2. Use `mapLanguage()` to set worker language (recreate workers if language changes)
3. Crop subtitle ROI before OCR
4. Preprocess cropped image
5. Adjust Y coordinates to account for crop offset

```javascript
async detectSubtitle({ imagePath, width, height, sourceLanguage }) {
  const w = Number(width) || 1280
  const h = Number(height) || 720

  // Map language
  const langs = mapLanguage(sourceLanguage)
  const langKey = langs.join('+')

  // Get or create workers for this language
  const workers = await getWorkers(langKey)
  const worker = workers[rr++ % workers.length]

  // Crop subtitle ROI (bottom 40%)
  const { croppedPath, cropY } = await cropSubtitleROI(imagePath, w, h, 0.4)

  // Preprocess
  const processedPath = await preprocessImage(croppedPath)

  try {
    const { data } = await worker.recognize(
      processedPath,
      { tessedit_pageseg_mode: PSM },
      { blocks: true }
    )

    const boxes = []
    const blocks = Array.isArray(data.blocks) ? data.blocks : []
    for (const block of blocks) {
      const lines = block.lines || []
      for (const line of lines) {
        const words = line.words || []
        if (!words.length) continue

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        let text = '', confSum = 0
        for (const word of words) {
          const b = word.bbox || {}
          const x0 = Number(b.x0), y0 = Number(b.y0)
          const x1 = Number(b.x1), y1 = Number(b.y1)
          if (!Number.isFinite(x0) || !Number.isFinite(x1)) continue
          minX = Math.min(minX, x0); minY = Math.min(minY, y0)
          maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1)
          text += (text ? ' ' : '') + (word.text || '')
          confSum += Number(word.confidence) || 0
        }
        if (!Number.isFinite(minX)) continue

        const confidence = words.length ? confSum / words.length / 100 : 0.6
        // Adjust Y coordinates back to full-frame space
        boxes.push({
          x: Math.round(minX),
          y: Math.round(minY + cropY),
          width: Math.round(Math.max(1, maxX - minX)),
          height: Math.round(Math.max(1, maxY - minY)),
          text: text.trim(),
          confidence: Number.isFinite(confidence) ? confidence : 0.6,
        })
      }
    }

    return { boxes, model: this.model, usage: null }
  } finally {
    // Cleanup temp files
    try { if (croppedPath !== imagePath) fs.unlinkSync(croppedPath) } catch {}
    try { if (processedPath !== croppedPath) fs.unlinkSync(processedPath) } catch {}
  }
}
```

- [ ] **Step 5: Update `getWorkers` to support dynamic language switching**

Replace the current `getWorkers` function to accept a language key and recreate workers when language changes:

```javascript
let currentLang = null
let workersPromise = null

async function getWorkers(langKey) {
  const lang = langKey || (LANG.length === 1 ? LANG[0] : LANG)
  if (workersPromise && currentLang === lang) return workersPromise
  // If language changed, recreate workers
  if (workersPromise && currentLang !== lang) {
    const oldWorkers = await workersPromise
    for (const w of oldWorkers) { try { await w.terminate() } catch {} }
    workersPromise = null
  }
  currentLang = lang
  workersPromise = (async () => {
    const ws = []
    for (let i = 0; i < POOL; i++) ws.push(await createWorker(lang))
    return ws
  })()
  return workersPromise
}
```

- [ ] **Step 6: Verify the file compiles**

Run: `cd backend && node -e "import('./src/providers/vision/tesseractOcr.js').then(() => console.log('OK'))"`
Expected: `OK`

---

### Task 2: Create `dubOcr.js` Pipeline Stage

**Files:**
- Create: `backend/src/pipeline/stages/dubOcr.js`

**Interfaces:**
- Consumes: `ctx.project`, `ctx.results['dub.ingest']` (for duration/dimensions)
- Produces: Writes to `transcript_segments` table, returns `{ segmentCount, language }`

- [ ] **Step 1: Create the dubOcr.js file**

```javascript
import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { insert, query } from '../../db/query.js'
import { sampleFrames, probe } from '../../media/mediaService.js'
import { getProvider } from '../../providers/registry.js'
import { callProvider } from '../../lib/callProvider.js'
import { projectDir, tmpDirOf, ensureDir, requireSourceFile, round2 } from '../context.js'

// dub.ocr — OCR-based subtitle recognition for hardsub videos.
// Extracts frames, runs OCR on each, aggregates results into transcript_segments.
export async function dubOcr(ctx) {
  const { project, job, setProgress, results, signal } = ctx
  const ingest = results['dub.ingest'] || {}
  const src = requireSourceFile(project.source_video_key, 'Video nguồn')
  const tmp = ensureDir(tmpDirOf(project.id))
  setProgress(2)

  if (signal?.aborted) throw new Error('Cancelled')

  // Skip if segments already exist (cached from duplicate project)
  const existing = await query(
    'SELECT COUNT(*) as cnt FROM transcript_segments WHERE project_id = ?',
    [project.id]
  )
  if (existing[0]?.cnt > 0) {
    return { segmentCount: existing[0].cnt, skipped: true, reason: 'cached' }
  }

  const params = parseParams(project.params)
  const sourceLanguage = params.sourceLanguage || 'auto'
  const durationSec = ingest.durationSec || (await probe(src)).durationSec || 0
  const width = ingest.width || 1280
  const height = ingest.height || 720

  // Extract frames at 1 FPS (cap at 600 frames)
  const framesDir = path.join(tmp, 'ocr_frames')
  const frames = await sampleFrames(src, framesDir, { fps: 1, cap: 600 })
  setProgress(5)

  if (frames.length === 0) {
    throw new Error('Không trích xuất được frame nào từ video')
  }

  // Get OCR provider
  const ocr = await getProvider(project.user_id, 'ocr')

  // Run OCR on each frame
  const allBoxes = []
  for (let i = 0; i < frames.length; i++) {
    if (signal?.aborted) throw new Error('Cancelled')

    const frame = frames[i]
    const result = await callProvider({
      provider: ocr.id,
      type: 'ocr',
      model: ocr.provider.model || ocr.id,
      input: { imagePath: frame.file, width, height, sourceLanguage },
      fn: () => ocr.provider.detectSubtitle({ imagePath: frame.file, width, height, sourceLanguage }),
      userId: project.user_id,
      apiKeyId: ocr.apiKeyId,
      projectId: project.id,
      jobId: job.id,
    })

    for (const box of result.boxes || []) {
      allBoxes.push({ ...box, timestamp: frame.t })
    }

    setProgress(5 + Math.round(((i + 1) / frames.length) * 55))
  }

  // Aggregate OCR results into segments
  const segments = aggregateBoxes(allBoxes, durationSec)
  setProgress(65)

  // Write to transcript_segments (set project_id on each)
  for (const seg of segments) {
    seg.project_id = project.id
    await insert('transcript_segments', seg)
  }

  // Cleanup frame files
  try { fs.rmSync(framesDir, { recursive: true, force: true }) } catch {}

  setProgress(100)

  return {
    segmentCount: segments.length,
    language: sourceLanguage !== 'auto' ? sourceLanguage : null,
  }
}

// Aggregate OCR boxes across frames into timeline segments.
function aggregateBoxes(allBoxes, durationSec) {
  if (allBoxes.length === 0) return []

  allBoxes.sort((a, b) => a.timestamp - b.timestamp || a.y - b.y)

  const segments = []
  let currentGroup = [allBoxes[0]]

  for (let i = 1; i < allBoxes.length; i++) {
    const prev = allBoxes[i - 1]
    const curr = allBoxes[i]
    const timeDiff = curr.timestamp - prev.timestamp
    const textSimilar = normalizeText(curr.text) === normalizeText(prev.text)

    if (timeDiff <= 2 && textSimilar) {
      currentGroup.push(curr)
    } else {
      segments.push(finalizeGroup(currentGroup))
      currentGroup = [curr]
    }
  }
  segments.push(finalizeGroup(currentGroup))

  // Merge adjacent segments with same text
  const merged = []
  for (const seg of segments) {
    if (merged.length > 0) {
      const last = merged[merged.length - 1]
      if (normalizeText(last.text) === normalizeText(seg.text) && seg.startSec - last.endSec <= 1.5) {
        last.endSec = seg.endSec
        last.confidence = Math.max(last.confidence, seg.confidence)
        continue
      }
    }
    merged.push(seg)
  }

  return merged
    .filter(s => s.text.trim().length > 0 && s.confidence >= 0.3)
    .map((s, i) => ({
      id: uuidv4(),
      project_id: undefined,
      index_num: i,
      start_sec: s.startSec,
      end_sec: s.endSec,
      text: s.text.trim(),
      speaker: null,
      language: null,
    }))
}

function finalizeGroup(group) {
  const textCounts = {}
  for (const box of group) {
    const t = normalizeText(box.text)
    textCounts[t] = (textCounts[t] || 0) + 1
  }
  const bestText = Object.entries(textCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || ''

  const timestamps = group.map(b => b.timestamp)
  const avgConf = group.reduce((s, b) => s + b.confidence, 0) / group.length

  return {
    text: group.find(b => normalizeText(b.text) === bestText)?.text || bestText,
    startSec: Math.max(0, Math.min(...timestamps)),
    endSec: Math.max(...timestamps) + 1,
    confidence: avgConf,
  }
}

function normalizeText(t) {
  return (t || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}

export default dubOcr
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd backend && node -e "import('./src/pipeline/stages/dubOcr.js').then(() => console.log('OK'))"`
Expected: `OK`

---

### Task 3: Register `dub.ocr` in Pipeline Runner

**Files:**
- Modify: `backend/src/pipeline/runner.js`

**Interfaces:**
- Consumes: `project.params.ocrMode` (boolean)
- Produces: Modified stage list, stage implementation mapping

- [ ] **Step 1: Import dubOcr**

Add import at the top of the file (after existing stage imports around line 8):

```javascript
import dubOcr from './stages/dubOcr.js'
```

- [ ] **Step 2: Add `dub.ocr` to STAGE_IMPL**

In the `STAGE_IMPL` object (around line 126), add:

```javascript
'dub.ocr': dubOcr,
```

- [ ] **Step 3: Add `dub.ocr` to STAGE_PROVIDER**

In the `STAGE_PROVIDER` object (around line 144), add:

```javascript
'dub.ocr': 'ocr',
```

- [ ] **Step 4: Add `dub.ocr` to RESETS**

In the `RESETS` object (around line 163), add:

```javascript
'dub.ocr': ['transcriptSegments', 'audios', 'subtitles', 'outputs'],
```

- [ ] **Step 5: Modify `startDubSequential` for conditional OCR**

Replace the `startDubSequential` function to check `params.ocrMode` and run either `dub.ocr` or `dub.stt`:

```javascript
async function startDubSequential(project, setProgress, results, signal) {
  const projectId = project.id
  const params = parseParams(project.params)
  const useOcr = Boolean(params.ocrMode)
  const firstStage = useOcr ? 'dub.ocr' : 'dub.stt'

  await ensureStageJob(projectId, firstStage)
  await ensureStageJob(projectId, 'dub.merge')

  const firstJob = await loadJob(projectId, firstStage)
  const firstOk = await executeStage(
    project, firstJob, {},
    (pct) => {
      const p = Math.max(0, Math.min(99, Math.round(pct)))
      updateById('generation_jobs', firstJob.id, { progress: p }).catch(() => {})
      eventBus.publish(projectId, { stage: firstStage, status: 'running', percent: p })
    },
    results,
    false,
    signal
  )

  if (!firstOk) return false

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

- [ ] **Step 6: Add `parseParams` helper if not already present**

Check if `parseParams` exists in the file. If not, add:

```javascript
function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}
```

- [ ] **Step 7: Update frontend constants**

In `frontend/src/lib/constants.jsx`, add to `STAGE_LABELS`:

```javascript
'dub.ocr': { label: 'Nhận dạng phụ đề (OCR)', icon: 'ScanText' },
```

And add `'dub.ocr'` to `STAGE_ORDER` array (before `'dub.stt'`):

```javascript
export const STAGE_ORDER = [
  ...['summary.transcribe', 'summary.sceneDetect', 'summary.analyze', 'summary.script', 'summary.align', 'summary.tts', 'summary.subtitle', 'summary.render'],
  ...['dub.ingest', 'dub.ocr', 'dub.stt', 'dub.translate', 'dub.ttsAlign', 'dub.render'],
];
```

And update `DUB_STAGES`:

```javascript
export const DUB_STAGES = ['dub.ingest', 'dub.ocr', 'dub.stt', 'dub.translate', 'dub.ttsAlign', 'dub.render'];
```

- [ ] **Step 8: Verify backend compiles**

Run: `cd backend && node -e "import('./src/pipeline/runner.js').then(() => console.log('OK'))"`
Expected: `OK`

---

### Task 4: Accept `ocrMode` in Project Creation API

**Files:**
- Modify: `backend/src/routes/v1/projects.js`

**Interfaces:**
- Consumes: `req.body.ocrMode` (boolean)
- Produces: `params.ocrMode` stored in project JSON

- [ ] **Step 1: Add ocrMode to params**

In the `POST /projects` handler, in the TRANSLATE_DUB params block (around line 74), add:

```javascript
params.ocrMode = Boolean(b.ocrMode ?? params.ocrMode ?? false)
```

- [ ] **Step 2: Verify backend compiles**

Run: `cd backend && node -e "import('./src/routes/v1/projects.js').then(() => console.log('OK'))"`
Expected: `OK`

---

### Task 5: Add OCR Toggle to Frontend CreateProject

**Files:**
- Modify: `frontend/src/pages/CreateProject.jsx`

**Interfaces:**
- Consumes: `form.ocrMode` state
- Produces: `ocrMode` in project creation payload

- [ ] **Step 1: Add ocrMode to initial state**

In the `useState` initialization (around line 48), add `ocrMode: false` to the form state.

- [ ] **Step 2: Add OCR toggle in Step 1 (Language selection)**

After the target language selector in Step 1 (around line 280), add an OCR mode toggle. Import `ScanText` from `lucide-react` at the top of the file:

```jsx
{/* OCR mode toggle — only when source language is not auto */}
{isDub && step === 1 && form.sourceLanguage !== 'auto' && (
  <div className="mt-4">
    <button onClick={() => update('ocrMode', !form.ocrMode)}
      className={`w-full flex items-center justify-between p-4 rounded-xl border transition ${form.ocrMode ? 'border-blue-500 bg-blue-500/10' : 'border-white/5 bg-white/[0.02] hover:border-white/15'}`}>
      <div className="text-left">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <ScanText className="w-4 h-4 text-blue-400" /> OCR phụ đề cứng
        </div>
        <div className="text-xs text-slate-400 mt-0.5">
          {form.ocrMode ? 'Bật — nhận dạng chữ từ phụ đề cứng trong video' : 'Tắt — dùng nhận dạng giọng nói (ASR)'}
        </div>
      </div>
      <span className={`relative w-11 h-6 rounded-full transition shrink-0 ${form.ocrMode ? 'bg-blue-600' : 'bg-white/10'}`}>
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${form.ocrMode ? 'translate-x-5' : ''}`} />
      </span>
    </button>
  </div>
)}
```

- [ ] **Step 3: Add ocrMode to the creation payload**

In `handleCreate`, add `ocrMode` to the TRANSLATE_DUB payload (around line 168):

```javascript
ocrMode: form.ocrMode,
```

- [ ] **Step 4: Add ocrMode to the review summary**

In the review step summary (around line 390), add OCR mode to the display:

```javascript
['OCR phụ đề cứng', form.ocrMode ? 'Bật' : 'Tắt'],
```

- [ ] **Step 5: Update canProceed validation**

In `canProceed`, when `step === 1` (language selection), if `ocrMode` is true, require `sourceLanguage !== 'auto'`:

```javascript
if (step === 1) {
  if (!form.targetLanguage) return false
  if (form.ocrMode && form.sourceLanguage === 'auto') return false
  return true
}
```

- [ ] **Step 6: Verify frontend builds**

Run: `cd frontend && npm run build`
Expected: Build succeeds with no errors

---

### Task 6: Add Tesseract Language Data Validation

**Files:**
- Modify: `backend/src/providers/vision/tesseractOcr.js`

**Interfaces:**
- Consumes: Language codes from `mapLanguage()`
- Produces: Clear error if required traineddata is missing

- [ ] **Step 1: Add language data validation**

In the `getWorkers` function, after creating workers, add a check that the language data loaded correctly. Tesseract.js will throw if the traineddata file is missing, so wrap the worker creation in a try/catch with a clear error message:

```javascript
async function getWorkers(langKey) {
  const lang = langKey || (LANG.length === 1 ? LANG[0] : LANG)
  if (workersPromise && currentLang === lang) return workersPromise
  if (workersPromise && currentLang !== lang) {
    const oldWorkers = await workersPromise
    for (const w of oldWorkers) { try { await w.terminate() } catch {} }
    workersPromise = null
  }
  currentLang = lang
  workersPromise = (async () => {
    try {
      const ws = []
      for (let i = 0; i < POOL; i++) ws.push(await createWorker(lang))
      return ws
    } catch (err) {
      const langs = Array.isArray(lang) ? lang : [lang]
      throw new Error(
        `OCR language data unavailable for: ${langs.join(', ')}. ` +
        `Ensure Tesseract traineddata files are installed. ` +
        `Error: ${err.message}`
      )
    }
  })()
  return workersPromise
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd backend && node -e "import('./src/providers/vision/tesseractOcr.js').then(() => console.log('OK'))"`
Expected: `OK`

---

### Task 7: Run Verification

- [ ] **Step 1: Verify backend imports**

Run: `cd backend && node -e "import('./src/pipeline/runner.js').then(() => console.log('Runner OK')); import('./src/providers/vision/tesseractOcr.js').then(() => console.log('TesseractOcr OK')); import('./src/pipeline/stages/dubOcr.js').then(() => console.log('dubOcr OK'))"`
Expected: All three print OK

- [ ] **Step 2: Run existing backend tests**

Run: `cd backend && npm test` (if test script exists)
Expected: Tests pass (or no tests found)

- [ ] **Step 3: Run frontend lint**

Run: `cd frontend && npm run lint`
Expected: No errors

- [ ] **Step 4: Run frontend build**

Run: `cd frontend && npm run build`
Expected: Build succeeds

- [ ] **Step 5: Run backend lint (if available)**

Run: `cd backend && npm run lint` (if lint script exists)
Expected: No errors

---

## OCR Data Flow After Implementation

```
[User selects OCR mode at project creation]
       |
       v
  params.ocrMode = true stored in project
       |
       v
  Pipeline runner checks params.ocrMode
       |
       v
  startDubSequential runs dub.ocr instead of dub.stt
       |
       v
  dub.ingest → dub.ocr → dub.merge → dub.translate → dub.ttsAlign → dub.render
                              |
  dub.ocr:                     |
    sampleFrames() → 1 FPS frames
    for each frame:
      cropSubtitleROI() → bottom 40%
      preprocessImage() → grayscale + contrast
      TesseractOcr.detectSubtitle() → boxes with text
    aggregateBoxes() → merge similar text across frames
    write transcript_segments.text
                              |
  dub.merge: validates transcript_segments exist
  dub.translate: reads transcript_segments.text (same as ASR path)
  dub.ttsAlign: reads transcript_segments.translation
  dub.render: burns subtitles + mixes audio
```

## ASR Data Flow (Unchanged)

```
[User does NOT select OCR mode]
       |
       v
  startDubSequential runs dub.stt (unchanged)
       |
       v
  dub.ingest → dub.stt → dub.merge → dub.translate → dub.ttsAlign → dub.render
```

## Test Scenarios

1. **ASR mode (default):** Create project without OCR → pipeline runs dub.stt → everything works as before
2. **OCR mode with English:** Create project with sourceLanguage=en, ocrMode=true → pipeline runs dub.ocr → English subtitles recognized → translated correctly
3. **OCR mode with Japanese:** sourceLanguage=ja → Tesseract uses jpn traineddata → Japanese subtitles recognized
4. **OCR mode with auto language:** Should be blocked in frontend (sourceLanguage must not be auto for OCR)
5. **OCR language data missing:** Should return clear error message, not silent fallback
6. **Low confidence filtering:** OCR results below 0.3 confidence are excluded
7. **Temporal aggregation:** Same subtitle text across multiple frames is merged into one segment
