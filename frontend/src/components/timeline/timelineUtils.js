/**
 * Utility functions for Timeline operations, time formatting, waveforms, and magnetic snapping.
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
 * 
 * @param {number} candidateStart - proposed start time in seconds
 * @param {number} duration - clip duration in seconds
 * @param {Array} allClips - all clips in timeline
 * @param {string} currentClipId - id of clip being dragged
 * @param {number} currentTime - playhead position in seconds
 * @param {number} zoomLevel - pixels per second
 * @param {number} thresholdPx - pixel distance threshold (default 10px)
 * @returns {{ snappedStart: number, snappedGuideTime: number | null }}
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

  // Gather all snap points: 0, playhead, and all other clips' start and end times
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
 * @param {number} targetEdge - proposed edge time in seconds
 * @param {Array} allClips - all clips in timeline
 * @param {string} currentClipId - id of clip being trimmed
 * @param {number} currentTime - playhead position
 * @param {number} zoomLevel - pixels per second
 * @param {number} thresholdPx - 10px default
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

/**
 * Generates an SVG path or series of mirrored bar heights for an audio waveform.
 * Uses a pseudo-random hash based on clip id to ensure identical visuals on every render.
 */
export function generateWaveformPoints(clipId, widthPx, barWidth = 3, barGap = 2) {
  const count = Math.max(5, Math.floor(widthPx / (barWidth + barGap)));
  const points = [];

  // Simple pseudo-random seed based on clipId string
  let seed = 0;
  for (let i = 0; i < clipId.length; i++) {
    seed = (seed * 31 + clipId.charCodeAt(i)) & 0xffffffff;
  }

  const seededRandom = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 4294967296;
  };

  for (let i = 0; i < count; i++) {
    // Generate organic sounding heights with peaks and dips
    const r1 = seededRandom();
    const r2 = Math.sin((i / count) * Math.PI * 4);
    const r3 = Math.cos((i / count) * Math.PI * 2);
    
    let height = Math.abs(r1 * 0.5 + r2 * 0.3 + r3 * 0.2);
    // Keep between 15% and 85% of track height
    height = Math.max(0.18, Math.min(0.85, height));
    points.push(height);
  }

  return points;
}
