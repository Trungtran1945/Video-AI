# TASK-018

## Title
Unref detached fallback kill timers in media ffmpeg runner

## Type
performance

## Priority
low

## Autonomy
auto

## Evidence
[backend/src/media/ffmpeg.js:66,73,88](file:///D:/E/Video_AI/backend/src/media/ffmpeg.js#L66): In `runBin()`, when handling abort signals or timeouts, `setTimeout(() => { try { child.kill('SIGKILL') } catch (_) {} }, 5000)` creates an unreferenced 5-second timer. Because `.unref()` is not called on the returned timer, the Node.js event loop is kept active for 5 seconds even after child processes exit, needlessly holding resources and delaying test suite completion.

## Affected Areas
- `backend/src/media/ffmpeg.js`

## Expected Outcome
Each fallback SIGKILL timeout calls `.unref()` (e.g. `setTimeout(...).unref()`), allowing the Node.js event loop to terminate promptly without waiting for the detached fallback timer to expire.

## Constraints
Do not alter the SIGKILL escalation logic or timeout duration (5000ms).

## Suggested Verification
`cd backend && node -e "import('./src/media/ffmpeg.js')"`

## Status
PENDING

FINAL_STATUS: SCAN_DONE
