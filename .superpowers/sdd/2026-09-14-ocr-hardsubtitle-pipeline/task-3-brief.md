# Task 3 Brief: Register dub.ocr in Pipeline Runner + Frontend Constants

## Task Description

Register the new `dub.ocr` stage in the pipeline runner and add its label to the frontend constants.

## Files to Modify

1. `backend/src/pipeline/runner.js`
2. `frontend/src/lib/constants.jsx`

## Changes to runner.js

### Step 1: Import dubOcr

Add import after existing stage imports (around line 8):
```javascript
import dubOcr from './stages/dubOcr.js'
```

### Step 2: Add to STAGE_IMPL

In the `STAGE_IMPL` object (around line 126), add:
```javascript
'dub.ocr': dubOcr,
```

### Step 3: Add to STAGE_PROVIDER

In the `STAGE_PROVIDER` object (around line 144), add:
```javascript
'dub.ocr': 'ocr',
```

### Step 4: Add to RESETS

In the `RESETS` object (around line 163), add:
```javascript
'dub.ocr': ['transcriptSegments', 'audios', 'subtitles', 'outputs'],
```

### Step 5: Modify startDubSequential for conditional OCR

Replace the `startDubSequential` function to check `params.ocrMode`:

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

### Step 6: Add parseParams helper if not present

Check if `parseParams` exists in the file. If not, add:
```javascript
function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}
```

## Changes to constants.jsx

### Step 7: Add dub.ocr to STAGE_LABELS

Add this line in the STAGE_LABELS object:
```javascript
'dub.ocr': { label: 'Nhận dạng phụ đề (OCR)', icon: 'ScanText' },
```

### Step 8: Add dub.ocr to STAGE_ORDER

Update the STAGE_ORDER array to include `dub.ocr` before `dub.stt`:
```javascript
export const STAGE_ORDER = [
  ...['summary.transcribe', 'summary.sceneDetect', 'summary.analyze', 'summary.script', 'summary.align', 'summary.tts', 'summary.subtitle', 'summary.render'],
  ...['dub.ingest', 'dub.ocr', 'dub.stt', 'dub.translate', 'dub.ttsAlign', 'dub.render'],
];
```

### Step 9: Update DUB_STAGES

```javascript
export const DUB_STAGES = ['dub.ingest', 'dub.ocr', 'dub.stt', 'dub.translate', 'dub.ttsAlign', 'dub.render'];
```

## Verification

After implementation, run:
```bash
cd backend && node -e "import('./src/pipeline/runner.js').then(() => console.log('OK'))"
```
Expected: `OK`
