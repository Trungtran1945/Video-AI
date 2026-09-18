# TASK-037

## Title
Guard against negative cursor advancement in buildTimelineRows for short clip transitions

## Type
bug

## Priority
high

## Autonomy
auto

## Evidence
[`alignService.js:130-131`](file:///D:/E/Video_AI/backend/src/pipeline/alignService.js#L130-L131): In `buildTimelineRows`, `cursor` is computed as `cursor += eff - (transitionOut ? TRANSITION_DURATION : 0)` where `eff = (clip.out_sec - clip.in_sec) / sm.speed`. When a clip slice has an effective duration `eff < TRANSITION_DURATION` (0.3s), `eff - TRANSITION_DURATION` evaluates to a negative value, causing `cursor` to move backwards. Consequently, subsequent clips receive decreasing or conflicting `start_at_sec` values, causing timeline assembly errors and audio-video desync in `summaryRender.js`.

## Affected Areas
- `backend/src/pipeline/alignService.js`

## Expected Outcome
Ensure the transition deduction cannot exceed the slice duration: clamp the cursor step to `Math.max(0.1, eff - (transitionOut ? Math.min(eff * 0.5, TRANSITION_DURATION) : 0))` so `cursor` is strictly monotonic and non-overlapping.

## Constraints
Preserve `TRANSITION_DURATION = 0.3` behavior for normal length clips.

## Suggested Verification
`cd backend && node -e "import('./src/pipeline/alignService.js')"`

## Status
PENDING
