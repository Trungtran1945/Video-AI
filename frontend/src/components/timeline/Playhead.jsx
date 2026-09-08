import React, { useState, useRef, useCallback } from 'react';
import { useTimelineStore } from './timelineStore';
import { formatTimeCode } from './timelineUtils';

export default function Playhead({ height, onSeek }) {
  const { currentTime, zoomLevel, setCurrentTime, snappingGuide } = useTimelineStore();
  const [isDragging, setIsDragging] = useState(false);
  const handleRef = useRef(null);

  const leftPx = currentTime * zoomLevel;

  const handlePointerDown = useCallback(
    (e) => {
      e.stopPropagation();
      setIsDragging(true);

      const handleElem = e.currentTarget;
      handleElem.setPointerCapture(e.pointerId);

      const parentScrollContainer = handleElem.closest('.timeline-scroll-container');
      const scrollLeft = parentScrollContainer ? parentScrollContainer.scrollLeft : 0;

      const updatePlayhead = (clientX) => {
        if (!parentScrollContainer) return;
        const currentScrollLeft = parentScrollContainer.scrollLeft;
        const rect = parentScrollContainer.getBoundingClientRect();
        const offsetX = clientX - rect.left + currentScrollLeft;
        const newSec = Math.max(0, offsetX / zoomLevel);
        setCurrentTime(newSec);
        onSeek?.(newSec);
      };

      const onPointerMove = (moveEvt) => {
        updatePlayhead(moveEvt.clientX);
      };

      const onPointerUp = (upEvt) => {
        setIsDragging(false);
        try {
          handleElem.releasePointerCapture(upEvt.pointerId);
        } catch {
          // ignore if already released
        }
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    },
    [zoomLevel, setCurrentTime]
  );

  return (
    <>
      {/* Magnetic Snapping Vertical White Guide Line */}
      {snappingGuide !== null && (
        <div
          style={{
            left: `${snappingGuide * zoomLevel}px`,
            height: `${height}px`,
          }}
          className="absolute top-0 w-[1px] bg-white z-40 pointer-events-none shadow-[0_0_8px_#ffffff]"
        >
          <div className="absolute top-1 left-1 bg-white text-zinc-950 font-mono text-[9px] px-1 py-0.2 rounded font-bold shadow-md">
            SNAP
          </div>
        </div>
      )}

      {/* Red Playhead Line & Draggable Handle */}
      <div
        style={{
          left: `${leftPx}px`,
          height: `${height}px`,
        }}
        className="absolute top-0 z-40 pointer-events-none group"
      >
        {/* Playhead Vertical Red Line */}
        <div className="w-[2px] h-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.8)] -translate-x-1/2" />

        {/* Playhead Top Draggable Handle */}
        <div
          ref={handleRef}
          onPointerDown={handlePointerDown}
          className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-0.5 cursor-ew-resize pointer-events-auto flex flex-col items-center select-none"
        >
          {/* Tooltip: Small black badge displaying MM:SS:FF while dragging (or hovering) */}
          {(isDragging || true) && (
            <div
              className={`absolute -top-7 left-1/2 -translate-x-1/2 bg-black/95 text-white border border-red-500/40 text-[11px] font-mono px-2 py-0.5 rounded shadow-xl whitespace-nowrap transition-opacity duration-150 pointer-events-none flex items-center gap-1.5 ${
                isDragging ? 'opacity-100 scale-105' : 'opacity-85 hover:opacity-100'
              }`}
            >
              <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              <span>{formatTimeCode(currentTime)}</span>
            </div>
          )}

          {/* CapCut Style Inverted Pentagon / Marker Handle */}
          <div className="w-3.5 h-4 bg-red-500 hover:bg-red-400 active:bg-red-600 rounded-t-sm shadow-md flex items-center justify-center transition-colors">
            <div className="w-1 h-2 bg-white/70 rounded-full" />
          </div>
          {/* Pointed bottom arrow */}
          <div className="w-0 h-0 border-x-[7px] border-x-transparent border-t-[6px] border-t-red-500" />
        </div>
      </div>
    </>
  );
}
