# TASK-032

## Title
Cache directory entries in dubRender audio resolver to eliminate repeated synchronous filesystem scans

## Type
performance

## Priority
low

## Autonomy
auto

## Evidence
[`dubRender.js:87-92`](file:///D:/E/Video_AI/backend/src/pipeline/stages/dubRender.js#L87-L92): `scanForSegment(segmentId)` executes `fs.readdirSync(segDir)` on every invocation. During segment-to-audio resolution, it is called repeatedly for every alignment and fallback row (lines 101, 110), resulting in quadratic synchronous directory traversal operations against disk.

## Affected Areas
- `backend/src/pipeline/stages/dubRender.js`

## Expected Outcome
Read `fs.readdirSync(segDir)` once into a memory array or map before scanning, and filter against the cached entries rather than reading from disk on every segment check.

## Constraints
Ensure filename filtering (`starts with seg_fit_` and `ends with .wav`) remains unchanged.

## Suggested Verification
`cd backend && node -e "import('./src/pipeline/stages/dubRender.js')"`

## Status
PENDING
