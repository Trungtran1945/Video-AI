# SDD ledger — plan: docs/superpowers/plans/2026-09-13-remove-ocr-mask-method-manual-timeline.md

## Pre-flight Scan

| Task Pair | Interface | Status | Ruling |
|-----------|-----------|--------|--------|
| Task 1 (runner.js) + Task 3 (dubRender.js) | Runner calls dubRender | Clean - Task 1 removes dub.ocr from stages, Task 3 removes mask logic from dubRender |
| Task 1 (runner.js) + Task 2 (dubMerge.js) | Runner calls dubMerge | Clean - Task 1 updates stage list, Task 2 updates dubMerge implementation |
| Task 3 (dubRender.js) + Task 4 (mediaService.js) | dubRender imports from mediaService | Clean - Task 3 removes maskRegions import, Task 4 removes the function |
| Task 5 (routes) + Task 4 (mediaService.js) | Routes import normalizeRegion | Clean - Task 5 removes the import, Task 4 removes the function |
| Task 9 (ProjectDetail.jsx) + Task 11 (SubRegionEditor.jsx) | ProjectDetail imports SubRegionEditor | Clean - Task 9 removes import, Task 11 deletes file |
| Task 7 (constants.jsx) + Task 9 (ProjectDetail.jsx) | ProjectDetail imports MASK_METHODS | Clean - Task 7 removes constant, Task 9 removes import |

## Task Status

- Task 1: done
- Task 2: pending
- Task 3: pending
- Task 4: pending
- Task 5: pending
- Task 6: pending
- Task 7: pending
- Task 8: pending
- Task 9: pending
- Task 10: pending
- Task 11: pending
- Task 12: pending
- Task 13: pending
- Task 14: pending
