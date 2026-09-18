# TASK-022

## Title
Guard against undefined scene descriptions in summaryAnalyze

## Type
bug

## Priority
medium

## Autonomy
auto

## Evidence
[summaryAnalyze.js:75-80](file:///D:/E/Video_AI/backend/src/pipeline/stages/summaryAnalyze.js#L75-L80): `describedList` is formed via `Array.isArray(results) ? results : [results]`. When `results` is a non-array object or has fewer elements than `batch.length`, `describedList[j]` is undefined for `j > 0`. Evaluating `described.text.slice(0, 500)` throws `TypeError: Cannot read properties of undefined (reading 'text')`, crashing the entire `summary.analyze` stage.

## Affected Areas
- `backend/src/pipeline/stages/summaryAnalyze.js`

## Expected Outcome
Implement safe extraction: `const text = String(described?.text || '').slice(0, 500)` and guard bounds to prevent runtime crashes during vision analysis.

## Constraints
Preserve thumbnail generation and embedding computation logic.

## Suggested Verification
`cd backend && node -e "import('./src/pipeline/stages/summaryAnalyze.js')"`

## Status
PENDING
