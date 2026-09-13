# Task 6: Backend - Delete dubOcr.js

## What I Implemented
Deleted `backend/src/pipeline/stages/dubOcr.js` (218 lines) — the OCR stage that detected subtitle regions via frame sampling and OCR providers. This stage is no longer needed after Tasks 1-5 removed all references.

## What I Tested
- Confirmed no active imports of `dubOcr` remain anywhere in the codebase (only self-references and comments in tesseractOcr.js and a test file)
- Verified `runner.js` still loads successfully after deletion
- Confirmed file is removed from disk

## Files Changed
- **Deleted:** `backend/src/pipeline/stages/dubOcr.js`

## Self-Review Findings
- Clean deletion — no orphaned references, no broken imports
- Comments referencing dubOcr in `tesseractOcr.js` and `maskBurn.regression.mjs` are harmless documentation, not functional code
