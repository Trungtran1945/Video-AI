import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatTimeCode,
  formatRulerTime,
  getMagneticSnap,
  getHandleSnap,
} from '../../frontend/src/components/timeline/timelineUtils.js'

test('formatTimeCode handles invalid, zero and boundary values', () => {
  assert.equal(formatTimeCode(-5), '00:00:00', 'Negative time clamped to 00:00:00')
  assert.equal(formatTimeCode(NaN), '00:00:00', 'NaN formatted as 00:00:00')
  assert.equal(formatTimeCode(null), '00:00:00', 'null formatted as 00:00:00')
  assert.equal(formatTimeCode(undefined), '00:00:00', 'undefined formatted as 00:00:00')
  assert.equal(formatTimeCode(0), '00:00:00', 'Zero formatted as 00:00:00')
})

test('formatTimeCode formats long duration with HH:MM:SS:FF', () => {
  // 3665.5 seconds = 1 hr, 1 min, 5.5 sec -> at 30 fps frame = 15
  assert.equal(formatTimeCode(3665.5, 30), '01:01:05:15')
  // 36000 seconds = 10 hrs
  assert.equal(formatTimeCode(36000, 30), '10:00:00:00')
})

test('formatTimeCode frames clamp to effectiveFps - 1', () => {
  // 0.999s at 30 fps: round(0.999 * 30) = 30, clamp should give 29 (not 30)
  const result = formatTimeCode(0.999, 30)
  assert.equal(result, '00:00:29', 'Frame number never exceeds fps - 1')
})

test('formatRulerTime formats whole and fractional seconds across zoom levels', () => {
  assert.equal(formatRulerTime(0), '00:00')
  assert.equal(formatRulerTime(59), '00:59')
  assert.equal(formatRulerTime(60), '01:00')
  assert.equal(formatRulerTime(3605), '01:00:05', 'Hour shown when > 3600s')
  // Fractional seconds
  assert.equal(formatRulerTime(12.5, 30), '00:12:15')
  assert.equal(formatRulerTime(-1), '00:00', 'Negative clamped to 00:00')
})

test('getMagneticSnap respects thresholdSec scaling with zoomLevel', () => {
  const allClips = [{ id: 'clip-1', start: 0, duration: 5 }]

  // At zoomLevel = 20, thresholdPx = 10 -> thresholdSec = 0.5s
  // Candidate at 5.4s is within 0.5s of clip-1 end (5.0s) -> snaps to 5.0s
  const snapZoom20 = getMagneticSnap({
    candidateStart: 5.4,
    duration: 3,
    allClips,
    currentClipId: 'clip-moving',
    currentTime: 20,
    zoomLevel: 20,
    thresholdPx: 10,
  })
  assert.equal(snapZoom20.snappedStart, 5.0)

  // At zoomLevel = 100, thresholdPx = 10 -> thresholdSec = 0.1s
  // Candidate at 5.4s is 0.4s away (> 0.1s) -> does NOT snap
  const snapZoom100 = getMagneticSnap({
    candidateStart: 5.4,
    duration: 3,
    allClips,
    currentClipId: 'clip-moving',
    currentTime: 20,
    zoomLevel: 100,
    thresholdPx: 10,
  })
  assert.equal(snapZoom100.snappedStart, 5.4)
})

test('getMagneticSnap prevents negative start time', () => {
  const allClips = [{ id: 'clip-1', start: 0, duration: 4 }]

  // Moving clip has duration 5. candidateStart = -0.5
  const result = getMagneticSnap({
    candidateStart: -0.5,
    duration: 5,
    allClips,
    currentClipId: 'clip-moving',
    currentTime: 10,
    zoomLevel: 50,
    thresholdPx: 10,
  })
  assert.equal(result.snappedStart, 0, 'Start time clamped to >= 0')
})

test('getMagneticSnap snaps to playhead (currentTime)', () => {
  const result = getMagneticSnap({
    candidateStart: 7.05,
    duration: 2,
    allClips: [],
    currentClipId: 'clip-moving',
    currentTime: 7.0,
    zoomLevel: 50,
    thresholdPx: 10, // thresholdSec = 0.2s -> delta 0.05 is within threshold
  })
  assert.equal(result.snappedStart, 7.0)
  assert.equal(result.snappedGuideTime, 7.0)
})

test('getHandleSnap clamps snappedEdge to 0 and respects threshold', () => {
  const resultNegative = getHandleSnap({
    targetEdge: -0.1,
    allClips: [],
    currentClipId: 'clip-1',
    currentTime: 5,
    zoomLevel: 50,
    thresholdPx: 10,
  })
  assert.equal(resultNegative.snappedEdge, 0)

  const allClips = [{ id: 'clip-1', start: 10, duration: 5 }]
  const resultSnap = getHandleSnap({
    targetEdge: 10.08,
    allClips,
    currentClipId: 'clip-2',
    currentTime: 0,
    zoomLevel: 50,
    thresholdPx: 10, // 0.2s
  })
  assert.equal(resultSnap.snappedEdge, 10.0)
  assert.equal(resultSnap.snappedGuideTime, 10.0)
})
