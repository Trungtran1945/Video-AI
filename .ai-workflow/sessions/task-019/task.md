# TASK-019

## Title
Fix NVENC hardware encoder probe in mediaService

## Type
bug

## Priority
high

## Autonomy
extra-verification

## Evidence
[mediaService.js:478-479](file:///D:/E/Video_AI/backend/src/media/mediaService.js#L478-L479): `encodeArgs()` checks `const { stderr } = await ffmpeg(['-hide_banner', '-encoders'])` and evaluates `nvencAvailable = stderr.includes('h264_nvenc')`. Because `ffmpeg` uses `runBin` with default `captureStdout: false`, and FFmpeg emits `-encoders` listing to `stdout` rather than `stderr`, `stderr` never contains `h264_nvenc`. As a consequence, `nvencAvailable` is always evaluated as `false`, permanently disabling hardware acceleration.

## Affected Areas
- `backend/src/media/mediaService.js`

## Expected Outcome
Pass `{ captureStdout: true }` to `ffmpeg(['-hide_banner', '-encoders'])` and inspect `stdout` (or stdout combined with stderr) for `h264_nvenc` so systems with NVIDIA GPUs properly utilize hardware NVENC encoding.

## Constraints
Preserve automatic fallback to `libx264` if NVENC fails during encoding.

## Suggested Verification
`cd backend && node --test tests/e2ePipeline30.test.mjs`

## Status
PENDING
