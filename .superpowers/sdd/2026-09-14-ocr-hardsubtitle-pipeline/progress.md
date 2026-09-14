# SDD ledger — plan: .opencode/plans/2026-09-14-ocr-hardsubtitle-pipeline.md

## Pre-flight Scan

| Tasks | Shared File/Interface | Producer → Consumer | Finding | Ruling |
|-------|----------------------|---------------------|---------|--------|
| T1 → T2 | `tesseractOcr.js` exports | T1 modifies `detectSubtitle` signature; T2 calls it | T2 adds `sourceLanguage` param — plan is consistent | Clean |
| T1 → T3 | `runner.js` imports `dubOcr` | T2 creates `dubOcr.js`; T3 imports it | Sequential — no conflict | Clean |
| T2 → T3 | `runner.js` STAGE_IMPL | T2 creates stage; T3 registers it | Sequential — no conflict | Clean |
| T3 → T4 | `projects.js` params | T3 reads `params.ocrMode`; T4 writes it | T4 must run before T3 reads from DB at runtime — but T3 registers static config, T4 writes on creation. No code conflict. | Clean |
| T3 → T5 | `constants.jsx` STAGE_LABELS | T3 modifies constants; T5 modifies CreateProject | Both frontend files but different concerns | Clean |
| T4 → T5 | `ocrMode` param contract | T5 sends `ocrMode`; T4 receives it | Plan is consistent — both use `params.ocrMode` boolean | Clean |
| T6 → T1 | `tesseractOcr.js` getWorkers | T6 adds error handling to same function T1 rewrites | T6 should be folded into T1 since both modify `getWorkers` | **Ruling: Merge T6 into T1** — both modify the same `getWorkers` function. T1 rewrites it completely, T6 adds error handling. Implementer should include error handling from T6 in T1's rewrite. T6 becomes a no-op verification step. |

## Execution Log

Task 1: complete (commits d0343ce..a602ce0, review clean)
- Spec ✅: all 5 requirements met (language mapping, ROI cropping, preprocessing, dynamic workers, error handling)
- 2 Important parked: race condition on concurrent calls (architectural, out of scope), not called from pipeline yet (Task 2+ will wire)
- 2 Minor deferred: dead default param, no sourceLanguage validation (acceptable — error handling covers it)

Task 2: complete (commits a602ce0..d4275e5, review clean)
- Spec ✅: new dubOcr.js created, matches brief exactly, correct schema, correct integration points
- 3 Minor deferred: unused durationSec param, unused imports (projectDir, round2), misleading undefined assignment

Task 3: complete (commits d4275e5..29c1d5d, review clean)
- Spec ✅: dubOcr registered in STAGE_IMPL/STAGE_PROVIDER/RESETS, startDubSequential conditionally runs dub.ocr/dub.stt, constants updated

Task 4: complete (commits 29c1d5d..f404f45, review clean — direct controller implementation, small one-line change)
- Spec ✅: params.ocrMode = Boolean(b.ocrMode ?? params.ocrMode ?? false) added to project creation

Task 5: complete (commits f404f45..837c426, review clean)
- Spec ✅: OCR toggle added to CreateProject Step 1, ocrMode in payload + review summary, validation updated

Task 7: complete (verification passed)
- Backend runner compiles ✅
- TesseractOcr compiles ✅
- dubOcr compiles ✅
- Frontend build succeeds ✅
- Frontend lint passes ✅

## Rulings Made

1. **T6 merged into T1** — Both modified `getWorkers`. T1's rewrite includes error handling from T6. Cost if wrong: T6's validation might have had additional checks not covered, but the brief's error handling is comprehensive.

## Summary

All 5 implementation tasks complete. Total commits: d0343ce → 837c426 (6 commits)

