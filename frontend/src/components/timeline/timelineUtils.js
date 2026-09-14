/**
 * Utility functions for Timeline operations, time formatting, and snapping.
 */

// Formats seconds into MM:SS:FF (30 frames per second standard)
export function formatTimeCode(totalSeconds, fps = 30) {
  if (isNaN(totalSeconds) || totalSeconds < 0) totalSeconds = 0;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const frames = Math.floor((totalSeconds % 1) * fps);

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const ff = String(frames).padStart(2, '0');

  return `${mm}:${ss}:${ff}`;
}

// Formats seconds for the sticky time ruler (e.g. 00:00, 00:05, 01:20)
export function formatRulerTime(totalSeconds) {
  if (isNaN(totalSeconds) || totalSeconds < 0) totalSeconds = 0;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  return `${mm}:${ss}`;
}

/**
 * Calculates magnetic snapping for a moving clip or handle.
 * Snaps to playhead, video start/end, and edges of clips on the SAME track only.
 */
export function getMagneticSnap({
  candidateStart,
  duration,
  allClips,
  currentClipId,
  currentTime,
  zoomLevel,
  thresholdPx = 10,
}) {
  const thresholdSec = thresholdPx / zoomLevel;
  const candidateEnd = candidateStart + duration;

  // Gather snap points: 0, playhead, and all other clips' start and end times (same track only)
  const snapPoints = [0];
  if (typeof currentTime === 'number' && currentTime >= 0) {
    snapPoints.push(currentTime);
  }

  allClips.forEach((c) => {
    if (c.id !== currentClipId) {
      snapPoints.push(c.start);
      snapPoints.push(c.start + c.duration);
    }
  });

  let minDelta = Infinity;
  let bestStart = candidateStart;
  let guideTime = null;

  for (const point of snapPoints) {
    // Check snapping to the left edge of candidate
    const leftDelta = Math.abs(candidateStart - point);
    if (leftDelta <= thresholdSec && leftDelta < minDelta) {
      minDelta = leftDelta;
      bestStart = point;
      guideTime = point;
    }

    // Check snapping to the right edge of candidate
    const rightDelta = Math.abs(candidateEnd - point);
    if (rightDelta <= thresholdSec && rightDelta < minDelta) {
      minDelta = rightDelta;
      bestStart = point - duration;
      guideTime = point;
    }
  }

  // Prevent start time before 0
  const finalStart = Math.max(0, Number(bestStart.toFixed(3)));

  return {
    snappedStart: finalStart,
    snappedGuideTime: guideTime,
  };
}

/**
 * Calculates snapping specifically for resize/trim handles.
 * Snaps to playhead, video start/end, and edges of clips on the SAME track only.
 */
export function getHandleSnap({
  targetEdge,
  allClips,
  currentClipId,
  currentTime,
  zoomLevel,
  thresholdPx = 10,
}) {
  const thresholdSec = thresholdPx / zoomLevel;
  const snapPoints = [0];
  if (typeof currentTime === 'number' && currentTime >= 0) {
    snapPoints.push(currentTime);
  }

  allClips.forEach((c) => {
    if (c.id !== currentClipId) {
      snapPoints.push(c.start);
      snapPoints.push(c.start + c.duration);
    }
  });

  let minDelta = Infinity;
  let bestEdge = targetEdge;
  let guideTime = null;

  for (const point of snapPoints) {
    const delta = Math.abs(targetEdge - point);
    if (delta <= thresholdSec && delta < minDelta) {
      minDelta = delta;
      bestEdge = point;
      guideTime = point;
    }
  }

  return {
    snappedEdge: Math.max(0, Number(bestEdge.toFixed(3))),
    snappedGuideTime: guideTime,
  };
}
