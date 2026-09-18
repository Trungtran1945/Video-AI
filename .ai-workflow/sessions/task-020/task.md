# TASK-020

## Title
Fix inverted tempo in forcedAlignService when audio exceeds slot

## Type
bug

## Priority
high

## Autonomy
extra-verification

## Evidence
[forcedAlignService.js:73-74](file:///D:/E/Video_AI/backend/src/pipeline/forcedAlignService.js#L73-L74): In `fitSegment()`, Case 2 (`ratio > 1 + STRETCH_THRESHOLD` and `!canShorten`), `tempo` is computed as `clamp(1 / ratio, TEMPO_MIN, TEMPO_MAX)` (which is < 1 for ratio > 1.2) and `effectiveDur` as `ttsDur * tempo`. In FFmpeg `atempo`, speedup requires `tempo > 1`. Case 4 (lines 114-116) correctly computes `neededTempo = ttsDur / slotDur` (> 1). The inverted calculation in Case 2 causes `applyTempoAudio` to slow down an already oversized audio clip, aggravating duration overflow and triggering `BLOCK_RENDER: physical audio exceeds slot`.

## Affected Areas
- `backend/src/pipeline/forcedAlignService.js`

## Expected Outcome
Compute `tempo` consistently as `clamp(ratio, TEMPO_MIN, TEMPO_MAX)` and `effectiveDurSec` as `round3(ttsDur / tempo)` so audio is accelerated to fit the target slot.

## Constraints
Pure function contracts and `TEMPO_MIN`/`TEMPO_MAX` limits must be preserved.

## Suggested Verification
`cd backend && node --test tests/shortenTranslationGate.test.mjs tests/ttsRenderGate.test.mjs`

## Status
PENDING
