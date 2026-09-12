# Task 1-3 Implementation Report

## What was implemented
- Removed `dub.ocr` stage from pipeline runner (imports, STAGES, STAGE_IMPL, STAGE_PROVIDER, RESETS, startDubParallel function)
- Simplified `dubMerge` to only check transcript segments (removed OCR region checks and job status checks)
- Removed `maskMethod` validation and constant from project creation route

## Files changed
1. `backend/src/pipeline/runner.js` - Removed dub.ocr references, simplified startDubParallel to run only dub.stt then dub.merge sequentially
2. `backend/src/pipeline/stages/dubMerge.js` - Replaced to only verify transcript_segments existence
3. `backend/src/routes/v1/projects.js` - Removed MASK_METHODS constant, maskMethod validation block, and params.maskMethod assignment

## Self-review findings
- No remaining references to `dub.ocr` in pipeline code (only in unused dubOcr.js file and a comment in ffmpeg.js)
- Pipeline import test passed (node -e import succeeded)
- Changes are minimal and surgical (only touching what's necessary)
- Manual OCR regions from SubRegionEditor are unaffected (ocr_regions table still exists)

## Commits created
1. `420c7a5` - feat: remove dub.ocr from pipeline runner
2. `9142953` - feat: simplify dubMerge to only check transcript segments
3. `269c409` - feat: remove maskMethod validation from project creation

## One-line test summary
Pipeline imports successfully, no compilation errors, all three backend modifications verified.

## Concerns
None - the changes are straightforward removals with no side effects on existing manual OCR functionality.