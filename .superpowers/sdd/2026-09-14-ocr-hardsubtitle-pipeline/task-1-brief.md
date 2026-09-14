# Task 1 Brief: Improve TesseractOcr Provider

## Task Description

Modify `backend/src/providers/vision/tesseractOcr.js` to add:
1. Language mapping from project sourceLanguage to Tesseract traineddata codes
2. Subtitle ROI cropping (bottom 40% of frame) before OCR
3. Image preprocessing (grayscale + contrast enhancement)
4. Dynamic language switching (recreate workers when language changes)
5. Clear error messages when Tesseract language data is missing

## Current File

The file is at `backend/src/providers/vision/tesseractOcr.js` (106 lines). It currently:
- Uses `OCR_LANG` env var (default `eng`) for language
- OCRs the full frame, then filters by Y coordinate (BOTTOM_RATIO)
- Has a worker pool with round-robin distribution
- Returns `{boxes, model, usage}` with boxes containing `{x, y, width, height, text, confidence}`

## Requirements

### Language Mapping

Add a `LANG_MAP` constant and `mapLanguage(sourceLanguage)` function:

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

### ROI Cropping

Add a `cropSubtitleROI` function using ffmpeg:

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

### Image Preprocessing

Add a `preprocessImage` function:

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

### Updated `detectSubtitle` Method

The method should:
1. Accept `{ imagePath, width, height, sourceLanguage }` (new `sourceLanguage` param)
2. Use `mapLanguage(sourceLanguage)` to determine Tesseract language
3. Call `getWorkers(langKey)` with the mapped language
4. Crop subtitle ROI before OCR
5. Preprocess the cropped image
6. Adjust Y coordinates back to full-frame space (add `cropY` offset)
7. Cleanup temp files in a `finally` block

### Updated `getWorkers` Function

Replace the current function to:
1. Accept a `langKey` parameter
2. Track `currentLang` to detect language changes
3. Terminate old workers and create new ones when language changes
4. Wrap worker creation in try/catch with clear error message for missing language data

### Updated Constants

Remove the module-level `LANG` constant (language is now dynamic per call).
Keep `BOTTOM_RATIO`, `PSM`, `POOL` as-is.

## Output Format

The return shape must remain identical:
```javascript
{
  boxes: [{ x, y, width, height, text, confidence }],
  model: 'tesseract',
  usage: null
}
```

## Files to Modify

- `backend/src/providers/vision/tesseractOcr.js`

## Verification

After implementation, run:
```bash
cd backend && node -e "import('./src/providers/vision/tesseractOcr.js').then(() => console.log('OK'))"
```
Expected: `OK`
