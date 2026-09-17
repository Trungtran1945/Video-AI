# Autonomous Project Scan

## Scan Time
2026-09-17T16:02:30Z

## Project Health
The Video_AI codebase has solid foundations with end-to-end pipeline execution, modular stage runners, and resilient provider fallbacks. However, several critical gaps exist across the queue workers, stage flow branching, and data persistence layers. Specifically, queued projects can be indefinitely starved due to lack of a scheduler or completion triggers, `ocrMode` is bypassed in the sequential runner, and partial segment timing updates silently nullify existing translations.

## Findings

### BUG
- [dubData.js:144-148](file:///D:/E/Video_AI/backend/src/routes/v1/dubData.js#L144-L148) â€” Updating timing (`startSec`/`endSec`) in `PUT /projects/:id/transcript` overwrites existing translations with `null` if `translation` is not explicitly provided.
- [runner.js:122-130](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L122-L130) & [runner.js:530-548](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L530-L548) â€” `STAGES.TRANSLATE_DUB` contains only single string entries, making `types.length === 1` always true and leaving `startDubSequential` unreachable; `dub.ocr` is never executed even when `params.ocrMode` is true.
- [generation.js:72-75](file:///D:/E/Video_AI/backend/src/routes/v1/generation.js#L72-L75) â€” `flatStages('TRANSLATE_DUB')` omits `dub.ocr`, blocking users from retrying `dub.ocr` with an unknown stage error.
- [drainQueued.js:48-63](file:///D:/E/Video_AI/backend/src/queue/workers/drainQueued.js#L48-L63) â€” `queryOne` is used instead of `query` for grouping queued projects by `user_id`, starving all subsequent users with queued projects.
- [drainQueued.js:19](file:///D:/E/Video_AI/backend/src/queue/workers/drainQueued.js#L19) & [runner.js:615-618](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L615-L618) â€” No cron or queue job triggers `drainQueued`, and `runPipeline.finally` does not trigger draining when active runs finish, leaving queued projects stuck indefinitely.
- [cleanupWorker.js:29-32](file:///D:/E/Video_AI/backend/src/queue/workers/cleanupWorker.js#L29-L32) â€” Project cleanup queries `status IN ('success', 'failed')` instead of `'completed'`, preventing any completed projects from ever having their expired files purged.
- [cleanupWorker.js:22-25](file:///D:/E/Video_AI/backend/src/queue/workers/cleanupWorker.js#L22-L25) â€” Expiration cutoff subtracts `retentionDays` from current time despite `expires_at` already being `created_at + retentionDays`, doubling retention time before cleanup.
- [dubIngest.js:26-28](file:///D:/E/Video_AI/backend/src/pipeline/stages/dubIngest.js#L26-L28) & [summaryTranscribe.js:27-29](file:///D:/E/Video_AI/backend/src/pipeline/stages/summaryTranscribe.js#L27-L29) â€” `extractAudio` is called unconditionally even if `info.hasAudio` is `false`, crashing the pipeline on silent/audio-less video input.

### SECURITY
- [auth.js:24-39](file:///D:/E/Video_AI/backend/src/routes/v1/auth.js#L24-L39) & [auth.js:130-148](file:///D:/E/Video_AI/backend/src/routes/v1/auth.js#L130-L148) â€” Registration and reset-password lack password length and complexity validation rules, allowing trivial passwords.
- [crypto.js:28-30](file:///D:/E/Video_AI/backend/src/lib/crypto.js#L28-L30) â€” `decrypt()` does not catch `decipher.final()` authentication failure errors, causing unhandled 500 crashes on corrupted API key decryption in `/api-keys`.

### PERFORMANCE
- [projects.js:166-180](file:///D:/E/Video_AI/backend/src/routes/v1/projects.js#L166-L180) â€” Sequential single-row `insert('transcript_segments', ...)` within a loop during project duplication/cache reuse instead of batch insertion.

### TEST
- [backend/tests/redisGuard.test.mjs:48-86](file:///D:/E/Video_AI/backend/tests/redisGuard.test.mjs#L48-L86) â€” Only checks static string patterns; lacks functional tests for `drainQueued` user selection, slot limits, and `cleanupWorker` sweep logic.

### REFACTOR
- [upload.js:46-50](file:///D:/E/Video_AI/backend/src/routes/v1/upload.js#L46-L50) & [upload.js:147](file:///D:/E/Video_AI/backend/src/routes/v1/upload.js#L147) â€” Completed upload moves the binary file but leaves empty `storage/tmp/upload_sessions/<id>` folders without directory cleanup.

### FEATURE OPPORTUNITY
- [confirmPreviewUseCase.js:28-34](file:///D:/E/Video_AI/backend/src/usecases/confirmPreviewUseCase.js#L28-L34) â€” Endpoint marks `previewConfirmed` in database params but does not trigger `runPipeline(projectId, 'dub.ttsAlign')` to proceed with rendering.

## Recommended Tasks
1. TASK-001 Prevent transcript PUT from nullifying translations on timing updates
2. TASK-002 Support ocrMode in pipeline runner stage resolution and retry
3. TASK-003 Fix drainQueued multi-user starvation and trigger on pipeline finish
4. TASK-004 Fix cleanupWorker project status query and retention calculation
5. TASK-005 Handle audio-less and silent video input in dubIngest and summaryTranscribe
6. TASK-006 Wire confirmPreviewUseCase to resume pipeline execution from dub.ttsAlign
7. TASK-007 Add integration tests for drainQueued and cleanupWorker

## Final Status
FINAL_STATUS: SCAN_DONE

---

# TASK-001

## Title
Prevent transcript PUT from nullifying translations on timing updates

## Type
bug

## Priority
high

## Autonomy
auto

## Evidence
[dubData.js:144-148](file:///D:/E/Video_AI/backend/src/routes/v1/dubData.js#L144-L148): In `PUT /api/v1/projects/:id/transcript`, line 144 assigns `const translation = typeof s.translation === 'string' ? s.translation : null`. When a client sends timing updates (`startSec`, `endSec`) without explicitly including `translation`, `s.translation` is undefined, setting `translation` to `null` and wiping existing segment translations in the database.

## Affected Areas
- `backend/src/routes/v1/dubData.js`
- `backend/tests/manualEdit.test.mjs`

## Expected Outcome
If `s.translation` is `undefined`, the segment's existing `translation` value (`seg.translation`) is preserved rather than overwritten with `null`.

## Constraints
Only set translation to `null` or new value when `translation` is explicitly provided in the payload; preserve existing `translation` when only updating timing.

## Suggested Verification
`cd backend && node --test tests/manualEdit.test.mjs`

## Status
PENDING

# TASK-002

## Title
Support ocrMode in pipeline runner stage resolution and retry

## Type
bug

## Priority
high

## Autonomy
extra-verification

## Evidence
[runner.js:122-130](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L122-L130), [runner.js:530-548](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L530-L548), and [generation.js:72-75](file:///D:/E/Video_AI/backend/src/routes/v1/generation.js#L72-L75): `STAGES.TRANSLATE_DUB` has only flat strings `['dub.ingest', 'dub.stt', 'dub.merge', ...]`. `runPipeline` checks `types.length === 1`, so `startDubSequential` is never reached. Even if `params.ocrMode` is true, `dub.stt` runs instead of `dub.ocr`. In addition, `flatStages('TRANSLATE_DUB')` excludes `dub.ocr`, so retrying `dub.ocr` returns 400 validation error.

## Affected Areas
- `backend/src/pipeline/runner.js`
- `backend/src/routes/v1/generation.js`

## Expected Outcome
When `params.ocrMode` is true, the pipeline correctly resolves and executes `dub.ocr` instead of `dub.stt`. `flatStages` and retry endpoints recognize `dub.ocr` as a valid runnable stage.

## Constraints
Preserve backward compatibility for non-OCR projects (`dub.stt` must remain default when `ocrMode` is false/absent).

## Suggested Verification
`cd backend && node --test tests/ocrTracks.test.mjs`

## Status
PENDING

# TASK-003

## Title
Fix drainQueued multi-user starvation and trigger on pipeline finish

## Type
bug

## Priority
high

## Autonomy
extra-verification

## Evidence
[drainQueued.js:48-63](file:///D:/E/Video_AI/backend/src/queue/workers/drainQueued.js#L48-L63) uses `queryOne` on a `GROUP BY user_id` query, returning only a single user record and ignoring all other users with queued projects. Furthermore, no repeat job triggers `drainQueued` on a recurring basis, and `runPipeline` in [runner.js:615-618](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L615-L618) does not trigger `drainQueued` upon completing an active run.

## Affected Areas
- `backend/src/queue/workers/drainQueued.js`
- `backend/server.js`
- `backend/src/pipeline/runner.js`

## Expected Outcome
`drainQueued` iterates through all users with queued projects using `query()`. `drainQueued` is scheduled via BullMQ repeat options (or triggered in `runPipeline`'s completion handler) so queued projects automatically resume when concurrency slots become available.

## Constraints
Do not exceed `config.maxConcurrentProjectsPerUser` per user. Handle Redis disconnected states gracefully.

## Suggested Verification
`cd backend && node --test tests/redisGuard.test.mjs`

## Status
PENDING

# TASK-004

## Title
Fix cleanupWorker project status query and retention calculation

## Type
bug

## Priority
medium

## Autonomy
extra-verification

## Evidence
[cleanupWorker.js:29-32](file:///D:/E/Video_AI/backend/src/queue/workers/cleanupWorker.js#L29-L32) filters `WHERE status IN ('success', 'failed')`. However, finished projects in `projects` table are marked `status = 'completed'` ([runner.js:567](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L567)). Completed projects are never cleaned. Additionally, line 23 subtracts `retentionDays` from current time before comparing against `expires_at`, which was already offset by `retentionDays` during project creation.

## Affected Areas
- `backend/src/queue/workers/cleanupWorker.js`

## Expected Outcome
The query matches `status IN ('completed', 'failed')` and compares `expires_at < new Date().toISOString()`, allowing expired project intermediate files to be properly deleted.

## Constraints
Never delete files referenced in `outputs` table (`outputs` rows and final render media must remain intact).

## Suggested Verification
`cd backend && node --test tests/redisGuard.test.mjs`

## Status
PENDING

# TASK-005

## Title
Handle audio-less and silent video input in dubIngest and summaryTranscribe

## Type
bug

## Priority
medium

## Autonomy
extra-verification

## Evidence
[dubIngest.js:26-28](file:///D:/E/Video_AI/backend/src/pipeline/stages/dubIngest.js#L26-L28) and [summaryTranscribe.js:27-29](file:///D:/E/Video_AI/backend/src/pipeline/stages/summaryTranscribe.js#L27-L29) call `extractAudio(src, rawWav)` without inspecting `info.hasAudio`. If a video has no audio track, FFmpeg fails with `Output file does not contain any stream`, crashing the ingest stage.

## Affected Areas
- `backend/src/pipeline/stages/dubIngest.js`
- `backend/src/pipeline/stages/summaryTranscribe.js`
- `backend/src/media/mediaService.js`

## Expected Outcome
When `info.hasAudio` is `false`, `extractAudio` or the calling stage generates an empty/silent WAV file (`anullsrc`) matching the video's duration, or bypasses audio extraction in OCR mode, preventing fatal pipeline errors.

## Constraints
Do not break existing audio extraction for media containing valid audio streams.

## Suggested Verification
`cd backend && node --test tests/e2ePipeline30.test.mjs`

## Status
PENDING

# TASK-006

## Title
Wire confirmPreviewUseCase to resume pipeline execution from dub.ttsAlign

## Type
feature

## Priority
medium

## Autonomy
auto

## Evidence
[confirmPreviewUseCase.js:28-34](file:///D:/E/Video_AI/backend/src/usecases/confirmPreviewUseCase.js#L28-L34): `confirmPreviewUseCase` records `previewConfirmed: true` in `project.params` and returns `{ message: 'Preview confirmed, render queued' }`, but never calls `runPipeline(projectId, 'dub.ttsAlign')` or triggers any queue job. The project remains parked.

## Affected Areas
- `backend/src/usecases/confirmPreviewUseCase.js`

## Expected Outcome
Calling `confirmPreviewUseCase` starts `runPipeline(projectId, 'dub.ttsAlign')` asynchronously so translation preview confirmation seamlessly transitions into TTS alignment and video render.

## Constraints
Ensure `isPipelineRunning(projectId)` is checked to avoid duplicate concurrent pipeline runs.

## Suggested Verification
`cd backend && node --test tests/renderValidation.test.mjs`

## Status
PENDING

# TASK-007

## Title
Add integration tests for drainQueued and cleanupWorker

## Type
test

## Priority
medium

## Autonomy
auto

## Evidence
Currently, `backend/tests/redisGuard.test.mjs` only tests file content strings (e.g. `!drainSrc.includes('updated_date')`). There are no automated tests that verify `drainQueued` drains multiple queued users up to `maxConcurrentProjectsPerUser`, or that `cleanupWorker` correctly purges intermediate project files when `expires_at` has passed.

## Affected Areas
- `backend/tests/drainQueued.test.mjs`
- `backend/tests/cleanupWorker.test.mjs`

## Expected Outcome
New automated tests verify that:
1. `drainQueued` handles multiple users with queued projects independently.
2. `cleanupWorker` identifies expired projects with `status = 'completed'` and deletes intermediate directories while preserving outputs.

## Constraints
Tests must run cleanly with in-memory SQLite (`sql.js`) without requiring a live Redis server instance.

## Suggested Verification
`cd backend && node --test tests/drainQueued.test.mjs tests/cleanupWorker.test.mjs`

## Status
PENDING

FINAL_STATUS: SCAN_DONE
