# Task 3 Report: Register dub.ocr in Pipeline Runner + Frontend Constants

## Status: DONE

## Changes Made

### backend/src/pipeline/runner.js

1. **Import added** (line 49): `import dubOcr from './stages/dubOcr.js'`
2. **STAGE_IMPL** (line 128): Added `'dub.ocr': dubOcr`
3. **STAGE_PROVIDER** (line 146): Added `'dub.ocr': 'ocr'`
4. **RESETS** (line 165): Added `'dub.ocr': ['transcriptSegments', 'audios', 'subtitles', 'outputs']`
5. **parseParams helper** (line 55): Added before `startDubSequential`
6. **startDubSequential replaced**: Now checks `params.ocrMode` — if true runs `dub.ocr` first, otherwise runs `dub.stt`

### frontend/src/lib/constants.jsx

7. **STAGE_LABELS**: Added `'dub.ocr': { label: 'Nhận dạng phụ đề (OCR)', icon: 'ScanText' }`
8. **STAGE_ORDER**: Added `dub.ocr` before `dub.stt` in the dub stages array
9. **DUB_STAGES**: Added `dub.ocr` before `dub.stt`

## Verification

Backend import test: **OK** — `node -e "import('./src/pipeline/runner.js').then(...)"` succeeded.
