# Task 4-5 Report: Remove dub.ocr from Frontend

## What Was Implemented

### Task 4: Remove `dub.ocr` from Frontend Constants
- Removed `'dub.ocr': { label: 'Quét phụ đề cứng (OCR)', icon: 'ScanText' }` from `STAGE_LABELS`
- Removed `'dub.ocr'` from `STAGE_ORDER` array
- Removed `'dub.ocr'` from `DUB_STAGES` array

### Task 5: Remove "Nâng Cao" Step from CreateProject Wizard
- Removed `Eraser` import from lucide-react
- Removed `MASK_METHODS` import from constants
- Removed `{ key: 'advanced', label: 'Nâng cao', icon: Eraser }` from `dubSteps` (now 5 steps)
- Removed `if (step === 4) return !!form.maskMethod;` validation from `canNext()`
- Removed entire "Nâng cao" JSX block (maskMethod selection + subPosition dropdown)
- Changed generate step index check from `step === 5` to `step === 4` for TRANSLATE_DUB
- Removed `maskMethod` and `maskStrength` from form defaults
- Removed `maskMethod` and `maskStrength` from API payload
- Removed `['Che chữ gốc', MASK_METHODS[form.maskMethod]?.label]` from summary display
- Updated TRANSLATE_DUB mode card description to mention manual SubRegionEditor instead of OCR

## Files Changed
- `frontend/src/lib/constants.jsx` — 3 removals (dub.ocr from STAGE_LABELS, STAGE_ORDER, DUB_STAGES)
- `frontend/src/pages/CreateProject.jsx` — 10 edits (import cleanup, wizard step removal, validation, JSX, payload, summary)

## Self-Review Findings
- Build succeeds (`npm run build` passes)
- No lint errors
- SUMMARY mode wizard (6 steps) unaffected
- TRANSLATE_DUB wizard now has 5 steps (video → language → preset → dubbing → generate)
- All `MASK_METHODS` references removed from CreateProject.jsx
- `MASK_METHODS` constant still exists in constants.jsx (may be used elsewhere; not removing per surgical change principle)

## Commits
- `fef7ffa` — feat: remove dub.ocr from frontend constants
- `66fc190` — feat: remove maskMethod wizard step from CreateProject
