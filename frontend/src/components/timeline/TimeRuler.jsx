import React, { useRef, useCallback } from 'react';
import { useTimelineStore } from './timelineStore';
import { formatRulerTime } from './timelineUtils';

export default function TimeRuler({ totalDuration, onSeek }) {
  const { zoomLevel, setCurrentTime } = useTimelineStore();
  const rulerRef = useRef(null);

  // Determine major and minor tick intervals based on zoomLevel (pixels per second)
  let majorInterval = 5; // seconds
  let minorInterval = 1; // seconds

  if (zoomLevel >= 120) {
    majorInterval = 1;
    minorInterval = 0.2;
  } else if (zoomLevel >= 70) {
    majorInterval = 2;
    minorInterval = 0.5;
  } else if (zoomLevel >= 35) {
    majorInterval = 5;
    minorInterval = 1;
  } else {
    majorInterval = 10;
    minorInterval = 2;
  }

  const handlePointerDown = useCallback(
    (e) => {
      if (!rulerRef.current) return;
      const target = rulerRef.current;
      target.setPointerCapture(e.pointerId);

      const updateSeek = (clientX) => {
        const rect = target.getBoundingClientRect();
        const offsetX = clientX - rect.left;
        const targetSec = Math.max(0, offsetX / zoomLevel);
        setCurrentTime(targetSec);
        onSeek?.(targetSec);
      };

      updateSeek(e.clientX);

      const onPointerMove = (moveEvt) => {
        updateSeek(moveEvt.clientX);
      };

      const onPointerUp = (upEvt) => {
        target.releasePointerCapture(upEvt.pointerId);
        target.removeEventListener('pointermove', onPointerMove);
        target.removeEventListener('pointerup', onPointerUp);
        target.removeEventListener('pointercancel', onPointerUp);
      };

      target.addEventListener('pointermove', onPointerMove);
      target.addEventListener('pointerup', onPointerUp);
      target.addEventListener('pointercancel', onPointerUp);
    },
    [zoomLevel, setCurrentTime]
  );

  const totalWidth = Math.max(1200, Math.ceil(totalDuration * zoomLevel));
  const numMajorTicks = Math.ceil(totalDuration / majorInterval) + 2;

  return (
    <div
      ref={rulerRef}
      onPointerDown={handlePointerDown}
      style={{ width: `${totalWidth}px` }}
      className="h-9 sticky top-0 z-30 bg-[#141418] border-b border-white/10 select-none cursor-pointer group"
    >
      {/* Background subtle hover line */}
      <div className="absolute inset-0 group-hover:bg-white/[0.02] transition-colors pointer-events-none" />

      {/* Render Major & Minor Ticks */}
      {Array.from({ length: numMajorTicks }).map((_, idx) => {
        const timeSec = idx * majorInterval;
        const leftPx = timeSec * zoomLevel;

        // Minor ticks between this major tick and next
        const numMinors = Math.round(majorInterval / minorInterval);
        const minorTicks = [];
        for (let m = 1; m < numMinors; m++) {
          const minorSec = timeSec + m * minorInterval;
          const minorPx = minorSec * zoomLevel;
          if (minorPx <= totalWidth) {
            minorTicks.push(minorPx);
          }
        }

        return (
          <React.Fragment key={`major-${idx}`}>
            {/* Major Tick Mark */}
            <div
              style={{ left: `${leftPx}px` }}
              className="absolute bottom-0 flex flex-col items-start pointer-events-none"
            >
              <span className="text-[10px] font-mono text-zinc-400 pl-1 -mt-0.5 leading-none">
                {formatRulerTime(timeSec)}
              </span>
              <div className="w-[1px] h-3 bg-zinc-500 mt-1" />
            </div>

            {/* Minor Ticks */}
            {minorTicks.map((mPx, mIdx) => (
              <div
                key={`minor-${idx}-${mIdx}`}
                style={{ left: `${mPx}px` }}
                className="absolute bottom-0 w-[1px] h-1.5 bg-zinc-700 pointer-events-none"
              />
            ))}
          </React.Fragment>
        );
      })}
    </div>
  );
}
