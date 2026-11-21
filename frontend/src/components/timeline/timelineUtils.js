/**
 * Utility functions for Timeline operations, time formatting, and snapping.
 */

// Formats seconds into HH:MM:SS:FF or MM:SS:FF (dynamic frames per second)
export function formatTimeCode(totalSeconds, fps = 30) {
  if (isNaN(totalSeconds) || totalSeconds < 0) totalSeconds = 0;

  const effectiveFps = Math.max(1, Math.round(Number(fps) || 30));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const frames = Math.min(effectiveFps - 1, Math.round((totalSeconds % 1) * effectiveFps));

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const ff = String(frames).padStart(2, '0');

  if (hours > 0) {
    const hh = String(hours).padStart(2, '0');
    return `${hh}:${mm}:${ss}:${ff}`;
  }

  return `${mm}:${ss}:${ff}`;
}

// Formats seconds for the sticky time ruler (e.g. 00:00, 00:05, 01:20)
export function formatRulerTime(totalSeconds, fps = 30) {
  if (isNaN(totalSeconds) || totalSeconds < 0) totalSeconds = 0;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const base = hours > 0 ? `${String(hours).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;

  if (Math.abs(totalSeconds % 1) > 0.001) {
    const effectiveFps = Math.max(1, Math.round(Number(fps) || 30));
    const frames = Math.min(effectiveFps - 1, Math.round((totalSeconds % 1) * effectiveFps));
    return `${base}:${String(frames).padStart(2, '0')}`;
  }

  return base;
}

/**
 * Calculates magnetic snapping for a moving clip or handle.
 * Snaps to playhead, video start/end, and edges of clips on the SAME track only.
 */
export function getMagneticSnap({
  candidateStart,
  duration,
  allClips = [],
  currentClipId,
  currentTime,
  zoomLevel,
  thresholdPx = 10,
}) {
  const thresholdSec = thresholdPx / zoomLevel;
  const candidateEnd = candidateStart + duration;

  // Gather snap points: 0, playhead, and all other clips' start and end times (same track only)
  const snapPoints = [0];
  if (typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime >= 0) {
    snapPoints.push(currentTime);
  }

  (allClips || []).forEach((c) => {
    if (c.id !== currentClipId) {
      const cStart = Number(c.start ?? c.start_at_sec ?? 0);
      const inSec = Number(c.in_sec ?? 0);
      const cDur = Number(c.duration ?? (c.out_sec != null ? c.out_sec - inSec : 4));
      if (Number.isFinite(cStart)) {
        snapPoints.push(cStart);
        if (Number.isFinite(cDur)) {
          snapPoints.push(cStart + cDur);
        }
      }
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
  allClips = [],
  currentClipId,
  currentTime,
  zoomLevel,
  thresholdPx = 10,
}) {
  const thresholdSec = thresholdPx / zoomLevel;
  const snapPoints = [0];
  if (typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime >= 0) {
    snapPoints.push(currentTime);
  }

  (allClips || []).forEach((c) => {
    if (c.id !== currentClipId) {
      const cStart = Number(c.start ?? c.start_at_sec ?? 0);
      const inSec = Number(c.in_sec ?? 0);
      const cDur = Number(c.duration ?? (c.out_sec != null ? c.out_sec - inSec : 4));
      if (Number.isFinite(cStart)) {
        snapPoints.push(cStart);
        if (Number.isFinite(cDur)) {
          snapPoints.push(cStart + cDur);
        }
      }
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
