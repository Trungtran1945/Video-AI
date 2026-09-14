import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTimeCode, formatRulerTime, getMagneticSnap, getHandleSnap } from './timelineUtils.js';

test('formatTimeCode formats mm:ss:ff correctly at 30 fps', () => {
  assert.equal(formatTimeCode(0), '00:00:00');
  assert.equal(formatTimeCode(65.5), '01:05:15');
  assert.equal(formatTimeCode(2.0), '00:02:00');
});

test('formatRulerTime formats mm:ss correctly', () => {
  assert.equal(formatRulerTime(0), '00:00');
  assert.equal(formatRulerTime(5), '00:05');
  assert.equal(formatRulerTime(75), '01:15');
});

test('getMagneticSnap snaps left edge when within 10px threshold', () => {
  // zoomLevel 50px/sec => 10px is 0.2 seconds
  const allClips = [
    { id: 'clip-1', start: 0, duration: 4 },
    { id: 'clip-2', start: 6, duration: 5 },
  ];

  // candidate start is 4.1s (0.1s away from clip-1 end at 4.0s) -> should snap to 4.0s
  const result = getMagneticSnap({
    candidateStart: 4.1,
    duration: 3,
    allClips,
    currentClipId: 'moving-clip',
    currentTime: 10,
    zoomLevel: 50,
    thresholdPx: 10,
  });

  assert.equal(result.snappedStart, 4.0);
  assert.equal(result.snappedGuideTime, 4.0);
});

test('getMagneticSnap snaps right edge when within 10px threshold', () => {
  const allClips = [
    { id: 'clip-1', start: 0, duration: 4 },
    { id: 'clip-2', start: 6, duration: 5 },
  ];

  // Moving clip has duration 2. candidateStart is 3.9 -> candidateEnd is 5.9 -> 0.1s away from clip-2 start (6.0s)
  // Should snap candidateEnd to 6.0, meaning snappedStart = 6.0 - 2.0 = 4.0
  const result = getMagneticSnap({
    candidateStart: 3.9,
    duration: 2,
    allClips,
    currentClipId: 'moving-clip',
    currentTime: 10,
    zoomLevel: 50,
    thresholdPx: 10,
  });

  assert.equal(result.snappedStart, 4.0);
  assert.equal(result.snappedGuideTime, 6.0);
});

test('getHandleSnap snaps edge when within threshold', () => {
  const allClips = [{ id: 'clip-1', start: 5, duration: 5 }];

  const result = getHandleSnap({
    targetEdge: 4.9,
    allClips,
    currentClipId: 'clip-2',
    currentTime: 2,
    zoomLevel: 50,
    thresholdPx: 10,
  });

  assert.equal(result.snappedEdge, 5.0);
  assert.equal(result.snappedGuideTime, 5.0);
});

