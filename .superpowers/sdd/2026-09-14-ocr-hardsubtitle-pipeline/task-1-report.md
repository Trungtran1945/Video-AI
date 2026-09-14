# Task 1 Report: Improve TesseractOcr Provider

**Status:** Done

## Changes Applied

All five requirements from the brief have been implemented in `backend/src/providers/vision/tesseractOcr.js`:

### 1. Language Mapping
- Added `LANG_MAP` constant with codes for en, ja, ko, zh, zh-TW, vi, fr, de, es
- Added `mapLanguage(sourceLanguage)` function supporting auto, single, and `+`-delimited languages
- Removed the module-level `LANG` constant (language is now dynamic per call)

### 2. ROI Cropping
- Added `cropSubtitleROI()` using ffmpeg to crop the bottom 40% of the frame
- Returns cropped path, cropY offset, and cropHeight; falls back to original image on failure

### 3. Image Preprocessing
- Added `preprocessImage()` using ffmpeg with `eq=contrast=1.3:brightness=0.05,format=gray`
- Falls back to original image on failure

### 4. Dynamic Language Switching
- `getWorkers(langKey)` now accepts a language parameter
- Tracks `currentLang` to detect language changes
- Terminates old workers and creates new ones when language changes

### 5. Error Messages for Missing Language Data
- Worker creation is wrapped in try/catch with a clear error message including the language code and original error

### 6. Updated `detectSubtitle` Method
- Accepts new `sourceLanguage` parameter
- Uses `mapLanguage(sourceLanguage)` to determine Tesseract language
- Calls `getWorkers(langCodes)` with mapped language
- Crops ROI and preprocesses before OCR
- Adjusts Y coordinates back to full-frame space (adds `cropY` offset)
- Cleans up temp files in `finally` block

## Verification

```
cd "D:\E\Video_AI\backend"; node -e "import('./src/providers/vision/tesseractOcr.js').then(() => console.log('OK'))"
OK
```

## Return Shape

Unchanged: `{ boxes: [{ x, y, width, height, text, confidence }], model: 'tesseract', usage: null }`
