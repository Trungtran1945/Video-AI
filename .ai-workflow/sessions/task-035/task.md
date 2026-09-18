# TASK-035

## Title
Batch insert transcript segments in dubStt and projects cache copy to eliminate synchronous disk I/O bottlenecks

## Type
performance

## Priority
medium

## Autonomy
auto

## Evidence
[`dubStt.js:101-103`](file:///D:/E/Video_AI/backend/src/pipeline/stages/dubStt.js#L101-L103) and [`projects.js:167-180`](file:///D:/E/Video_AI/backend/src/routes/v1/projects.js#L167-L180): In `dubStt`, the stage iterates `for (const seg of segments) await insert('transcript_segments', seg)`. In `db/query.js`, `insert()` invokes `run()` which invokes `save()` (`db.export()` + synchronous `fs.writeFileSync(DB_PATH)`). For typical video inputs with 500â€“1,000 speech segments, this executes hundreds of full in-memory SQLite database serializations and blocking filesystem rewrites sequentially. Similarly, transcript copying in `projects.js` inserts rows in an unbatched loop.

## Affected Areas
- `backend/src/pipeline/stages/dubStt.js`
- `backend/src/routes/v1/projects.js`

## Expected Outcome
Replace individual `insert` loops with `insertMany('transcript_segments', segments)` from `context.js`, writing all transcript segments in a single atomic SQL statement and single `save()` disk sync.

## Constraints
Preserve all fields: `id`, `project_id`, `index_num`, `start_sec`, `end_sec`, `text`, `speaker`, `language`, `translation`.

## Suggested Verification
`cd backend && node -e "import('./src/pipeline/stages/dubStt.js')"`

## Status
PENDING
