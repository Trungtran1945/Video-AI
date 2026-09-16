import React, { useState, useRef } from 'react';
import { Type, GripVertical, Film } from 'lucide-react';
import { useTimelineStore } from './timelineStore';
import { getMagneticSnap, getHandleSnap } from './timelineUtils';
import FloatingToolbar from './FloatingToolbar';

export default function TimelineClip({ clip, isTrackLocked, onSegmentClick, isActive = false }) {
  const {
    zoomLevel,
    currentTime,
    clips,
    selectedClipId,
    setSelectedClipId,
    updateClip,
    setSnappingGuide,
    snappingEnabled,
  } = useTimelineStore();

  const [isDraggingClip, setIsDraggingClip] = useState(false);
  const [isTrimming, setIsTrimming] = useState(false);
  const clipRef = useRef(null);

  const isSelected = selectedClipId === clip.id;
  const leftPx = clip.start * zoomLevel;
  const widthPx = Math.max(20, clip.duration * zoomLevel);

  const isEditable = clip.type === 'translated';

  // Get clips on the same track for snapping (only same-layer snapping)
  const sameTrackClips = clips.filter((c) => c.trackId === clip.trackId && c.id !== clip.id);

  const handleClipPointerDown = (e) => {
    if (e.target.closest('.trim-handle') || e.target.closest('.floating-toolbar')) {
      return;
    }

    e.stopPropagation();
    setSelectedClipId(clip.id);

    // Click to seek for all clip types
    if (clip.segmentId && onSegmentClick) {
      onSegmentClick(clip.segmentId);
    }

    // Only allow dragging for editable (translated) clips
    if (!isEditable || isTrackLocked) return;

    const startX = e.clientX;
    const initialStart = clip.start;
    let hasMoved = false;

    const onPointerMove = (moveEvt) => {
      const deltaX = moveEvt.clientX - startX;
      if (Math.abs(deltaX) > 2) {
        hasMoved = true;
        setIsDraggingClip(true);
      }

      if (!hasMoved) return;

      const rawCandidateStart = Math.max(0, initialStart + deltaX / zoomLevel);

      if (snappingEnabled) {
        const { snappedStart, snappedGuideTime } = getMagneticSnap({
          candidateStart: rawCandidateStart,
          duration: clip.duration,
          allClips: sameTrackClips,
          currentClipId: clip.id,
          currentTime,
          zoomLevel,
          thresholdPx: 10,
        });

        updateClip(clip.id, { start: snappedStart });
        setSnappingGuide(snappedGuideTime);
      } else {
        updateClip(clip.id, { start: Number(rawCandidateStart.toFixed(3)) });
        setSnappingGuide(null);
      }
    };

    const onPointerUp = () => {
      setIsDraggingClip(false);
      setSnappingGuide(null);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  const handleLeftTrimPointerDown = (e) => {
    e.stopPropagation();
    if (!isEditable || isTrackLocked) return;

    setIsTrimming(true);
    const startX = e.clientX;
    const initialStart = clip.start;
    const fixedEnd = clip.start + clip.duration;
    const minDuration = 0.25;

    const onPointerMove = (moveEvt) => {
      const deltaX = moveEvt.clientX - startX;
      let rawStart = initialStart + deltaX / zoomLevel;

      if (snappingEnabled) {
        const { snappedEdge, snappedGuideTime } = getHandleSnap({
          targetEdge: rawStart,
          allClips: sameTrackClips,
          currentClipId: clip.id,
          currentTime,
          zoomLevel,
          thresholdPx: 10,
        });
        rawStart = snappedEdge;
        setSnappingGuide(snappedGuideTime);
      } else {
        setSnappingGuide(null);
      }

      rawStart = Math.max(0, Math.min(rawStart, fixedEnd - minDuration));
      const newDuration = Number((fixedEnd - rawStart).toFixed(3));

      updateClip(clip.id, {
        start: Number(rawStart.toFixed(3)),
        duration: newDuration,
      });
    };

    const onPointerUp = () => {
      setIsTrimming(false);
      setSnappingGuide(null);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  const handleRightTrimPointerDown = (e) => {
    e.stopPropagation();
    if (!isEditable || isTrackLocked) return;

    setIsTrimming(true);
    const startX = e.clientX;
    const fixedStart = clip.start;
    const initialDuration = clip.duration;
    const minDuration = 0.25;

    const onPointerMove = (moveEvt) => {
      const deltaX = moveEvt.clientX - startX;
      let rawEnd = (fixedStart + initialDuration) + deltaX / zoomLevel;

      if (snappingEnabled) {
        const { snappedEdge, snappedGuideTime } = getHandleSnap({
          targetEdge: rawEnd,
          allClips: sameTrackClips,
          currentClipId: clip.id,
          currentTime,
          zoomLevel,
          thresholdPx: 10,
        });
        rawEnd = snappedEdge;
        setSnappingGuide(snappedGuideTime);
      } else {
        setSnappingGuide(null);
      }

      rawEnd = Math.max(fixedStart + minDuration, rawEnd);
      const newDuration = Number((rawEnd - fixedStart).toFixed(3));

      updateClip(clip.id, { duration: newDuration });
    };

    const onPointerUp = () => {
      setIsTrimming(false);
      setSnappingGuide(null);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  // Video track: simple reference bar
  if (clip.type === 'video') {
    return (
      <div
        ref={clipRef}
        style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
        className="absolute top-1.5 bottom-1.5 rounded select-none z-10"
      >
        <div className="w-full h-full bg-secondary/80 dark:bg-[#1e1e26] rounded border border-border dark:border-white/10 flex items-center px-2 gap-2 overflow-hidden">
          <Film size={12} className="text-blue-600 dark:text-blue-400 flex-shrink-0" />
          <span className="text-[10px] font-medium text-secondary-foreground dark:text-zinc-300 truncate">{clip.content}</span>
          <span className="text-[9px] font-mono text-muted-foreground flex-shrink-0 ml-auto">
            {clip.duration.toFixed(1)}s
          </span>
        </div>
      </div>
    );
  }

  // Subtitle track (original or translated)
  const bgColor = clip.type === 'original'
    ? 'bg-amber-50 dark:bg-[#3b2308]'
    : 'bg-emerald-50 dark:bg-[#063321]';
  const borderColor = clip.type === 'original'
    ? 'border-amber-300 dark:border-amber-500/30'
    : 'border-emerald-300 dark:border-emerald-500/30';
  const textColor = clip.type === 'original'
    ? 'text-amber-900 dark:text-amber-200'
    : 'text-emerald-900 dark:text-emerald-200';
  const badgeColor = clip.type === 'original'
    ? 'text-amber-800 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/80 border-amber-300 dark:border-amber-500/20'
    : 'text-emerald-800 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-950/80 border-emerald-300 dark:border-emerald-500/20';
  const iconBg = clip.type === 'original'
    ? 'bg-amber-100 dark:bg-amber-500/20 border-amber-300 dark:border-amber-500/40'
    : 'bg-emerald-100 dark:bg-emerald-500/20 border-emerald-300 dark:border-emerald-500/40';
  const iconColor = clip.type === 'original'
    ? 'text-amber-700 dark:text-amber-300'
    : 'text-emerald-700 dark:text-emerald-300';

  return (
    <div
      ref={clipRef}
      onPointerDown={handleClipPointerDown}
      style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
      className={`absolute top-1.5 bottom-1.5 rounded select-none transition-all duration-100 flex items-center overflow-visible group ${
        isEditable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
      } ${
        isSelected
          ? 'ring-2 ring-primary border-2 border-primary shadow-md z-20'
          : isActive
          ? 'border-2 border-amber-500 ring-1 ring-amber-500/40 shadow-sm z-15'
          : `border ${borderColor} hover:border-primary/50 z-10`
      }`}
    >
      {isSelected && isEditable && !isDraggingClip && !isTrimming && (
        <div className="floating-toolbar">
          <FloatingToolbar clip={clip} />
        </div>
      )}

      <div className={`w-full h-full rounded overflow-hidden relative flex items-center justify-between px-2.5 ${bgColor}`}>
        <div className="flex items-center gap-2 truncate">
          <div className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 ${iconBg}`}>
            <Type size={12} className={`font-bold ${iconColor}`} />
          </div>
          <span className={`text-[11px] font-semibold truncate ${textColor}`}>
            {clip.content ? `"${clip.content}"` : ''}
          </span>
        </div>
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border flex-shrink-0 ml-1 ${badgeColor}`}>
          {clip.duration.toFixed(1)}s
        </span>
      </div>

      {isSelected && isEditable && (
        <div
          onPointerDown={handleLeftTrimPointerDown}
          className="trim-handle absolute left-0 top-0 bottom-0 w-2.5 bg-card hover:bg-accent border border-border dark:bg-zinc-200 dark:hover:bg-white dark:border-zinc-400 cursor-ew-resize rounded-l flex items-center justify-center shadow-md transition-colors z-30"
          title="Drag to trim start"
        >
          <GripVertical size={10} className="text-foreground dark:text-zinc-800" />
        </div>
      )}

      {isSelected && isEditable && (
        <div
          onPointerDown={handleRightTrimPointerDown}
          className="trim-handle absolute right-0 top-0 bottom-0 w-2.5 bg-card hover:bg-accent border border-border dark:bg-zinc-200 dark:hover:bg-white dark:border-zinc-400 cursor-ew-resize rounded-r flex items-center justify-center shadow-md transition-colors z-30"
          title="Drag to trim end"
        >
          <GripVertical size={10} className="text-foreground dark:text-zinc-800" />
        </div>
      )}
    </div>
  );
}
