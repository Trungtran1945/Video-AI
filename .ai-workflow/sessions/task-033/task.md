# TASK-033

## Title
Optimize quadratic segment lookup in dubTtsAlign placement mapping

## Type
performance

## Priority
low

## Autonomy
auto

## Evidence
[`dubTtsAlign.js:206-210`](file:///D:/E/Video_AI/backend/src/pipeline/stages/dubTtsAlign.js#L206-L210): In `placeSegments(fitted.map(...))`, `segments.find(s => s.id === f.segmentId)` is called twice per element inside the map iterator. For projects with many segments, this causes $O(N^2)$ linear searches across the `segments` array instead of using an indexed Map.

## Affected Areas
- `backend/src/pipeline/stages/dubTtsAlign.js`

## Expected Outcome
Construct a `Map(segments.map(s => [s.id, s]))` before calling `placeSegments`, allowing $O(1)$ lookups for `start_sec` and `end_sec`.

## Constraints
Preserve default fallback values (0) when a segment ID is not found.

## Suggested Verification
`cd backend && node -e "import('./src/pipeline/stages/dubTtsAlign.js')"`

## Status
PENDING
