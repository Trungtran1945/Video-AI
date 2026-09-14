# Task 5 Brief: Add OCR Toggle to Frontend CreateProject

## Task Description

Add an OCR mode toggle to the TRANSLATE_DUB wizard in `frontend/src/pages/CreateProject.jsx`.

## Changes Required

### 1. Add `ocrMode: false` to initial form state

In the `useState` initialization (around line 48), add `ocrMode: false` to the form state object.

### 2. Add `ScanText` import from lucide-react

At the top of the file, find the lucide-react imports and add `ScanText`:
```javascript
import { ..., ScanText } from 'lucide-react'
```

### 3. Add OCR toggle in Step 1 (Language selection)

After the target language selector in Step 1 (after the `</div>` that closes the target language grid, around line 280), add:

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

### 4. Add `ocrMode` to the creation payload

In `handleCreate`, in the TRANSLATE_DUB payload (around line 168), add:
```javascript
ocrMode: form.ocrMode,
```

### 5. Add `ocrMode` to the review summary

In the review step summary array (around line 390), add after the enableDubbing line:
```javascript
['OCR phụ đề cứng', form.ocrMode ? 'Bật' : 'Tắt'],
```

### 6. Update canProceed validation

In `canProceed`, when `step === 1`, if `ocrMode` is true, require `sourceLanguage !== 'auto'`:

Current code (around line 134):
```javascript
if (step === 1) return !!form.targetLanguage;
```

Replace with:
```javascript
if (step === 1) {
  if (!form.targetLanguage) return false
  if (form.ocrMode && form.sourceLanguage === 'auto') return false
  return true
}
```

## Files to Modify

- `frontend/src/pages/CreateProject.jsx`

## Verification

After implementation, run:
```bash
cd frontend && npm run build
```
Expected: Build succeeds with no errors
