# TASK-043

## Title
Clean up AbortSignal listeners on process exit in media FFmpeg

## Type
performance

## Priority
medium

## Autonomy
auto

## Evidence
[`ffmpeg.js:63-81, 106-120`](file:///D:/E/Video_AI/backend/src/media/ffmpeg.js#L63-L120): In `runBin`, if a `signal` is passed in `opts`, it registers `signal.addEventListener('abort', onAbort, { once: true })`. However, when the child process exits normally at `child.on('close')`, errors out at `child.on('error')`, or times out, `signal.removeEventListener('abort', onAbort)` is never invoked. In long-running pipelines with dozens of video cuts, probes, and slices attached to the same run signal, this causes event listener accumulation and triggers Node.js `MaxListenersExceededWarning`.

## Affected Areas
- `backend/src/media/ffmpeg.js`

## Expected Outcome
In `runBin`, store a reference to `cleanupSignal` and call `signal.removeEventListener('abort', onAbort)` inside the process close, error, and timeout resolution handlers.

## Constraints
Preserve immediate process termination (`kill('SIGTERM')` and `kill('SIGKILL')`) when an abort event actually occurs.

## Suggested Verification
`cd backend && node -e "import('./src/media/ffmpeg.js')"`

## Status
PENDING
