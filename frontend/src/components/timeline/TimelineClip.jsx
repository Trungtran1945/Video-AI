import React, { useState, useRef, useMemo } from 'react';
import { Video, Music, Type, GripVertical } from 'lucide-react';
import { useTimelineStore } from './timelineStore';
import { getMagneticSnap, getHandleSnap, generateWaveformPoints } from './timelineUtils';
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
    snapEdgesForTrack,
  } = useTimelineStore();

  const [isDraggingClip, setIsDraggingClip] = useState(false);
  const [isTrimming, setIsTrimming] = useState(false);
  const clipRef = useRef(null);

  const isSelected = selectedClipId === clip.id;
  const leftPx = clip.start * zoomLevel;
  const widthPx = Math.max(20, clip.duration * zoomLevel);

  // 1. Clip Selection & Drag-to-Move
  const handleClipPointerDown = (e) => {
    // If clicking a handle or toolbar, let that handle it
    if (e.target.closest('.trim-handle') || e.target.closest('.floating-toolbar')) {
      return;
    }

    e.stopPropagation();
    setSelectedClipId(clip.id);
    if (clip.segmentId && onSegmentClick) {
      onSegmentClick(clip.segmentId);
    }

    if (isTrackLocked) return;

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
          allClips: clips,
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
      snapEdgesForTrack(clip.trackId);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  // 2. Left Trim Handle Drag
  const handleLeftTrimPointerDown = (e) => {
    e.stopPropagation();
    if (isTrackLocked) return;

    setIsTrimming(true);
    const startX = e.clientX;
    const initialStart = clip.start;
    const fixedEnd = clip.start + clip.duration;
    const minDuration = 0.25; // seconds

    const onPointerMove = (moveEvt) => {
      const deltaX = moveEvt.clientX - startX;
      let rawStart = initialStart + deltaX / zoomLevel;

      if (snappingEnabled) {
        const { snappedEdge, snappedGuideTime } = getHandleSnap({
          targetEdge: rawStart,
          allClips: clips,
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

      // Constrain within valid range
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
      snapEdgesForTrack(clip.trackId);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  // 3. Right Trim Handle Drag
  const handleRightTrimPointerDown = (e) => {
    e.stopPropagation();
    if (isTrackLocked) return;

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
          allClips: clips,
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

      // Constrain minimum duration
      rawEnd = Math.max(fixedStart + minDuration, rawEnd);
      const newDuration = Number((rawEnd - fixedStart).toFixed(3));

      updateClip(clip.id, { duration: newDuration });
    };

    const onPointerUp = () => {
      setIsTrimming(false);
      setSnappingGuide(null);
      snapEdgesForTrack(clip.trackId);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  // Audio Waveform points
  const waveformBars = useMemo(() => {
    if (clip.type !== 'audio') return [];
    return generateWaveformPoints(clip.id, widthPx, 3, 2);
  }, [clip.id, clip.type, widthPx]);

  // Video Filmstrip simulation: calculate number of frames
  const frameCount = useMemo(() => {
    if (clip.type !== 'video') return 0;
    return Math.max(1, Math.floor(widthPx / 56));
  }, [clip.type, widthPx]);

  return (
    <div
      ref={clipRef}
      onPointerDown={handleClipPointerDown}
      style={{
        left: `${leftPx}px`,
        width: `${widthPx}px`,
      }}
      className={`absolute top-1.5 bottom-1.5 rounded select-none cursor-grab active:cursor-grabbing transition-all duration-100 flex items-center overflow-visible group ${
        isSelected
          ? 'ring-2 ring-white border-2 border-white shadow-[0_0_15px_rgba(255,255,255,0.35)] z-20'
          : isActive
          ? 'border-2 border-amber-400/90 ring-1 ring-amber-400/40 shadow-[0_0_12px_rgba(251,191,36,0.35)] z-15'
          : 'border border-white/10 hover:border-white/25 z-10'
      } ${isTrackLocked ? 'opacity-65 cursor-not-allowed' : ''}`}
    >
      {/* Floating Action Toolbar above selected clip */}
      {isSelected && !isDraggingClip && !isTrimming && (
        <div className="floating-toolbar">
          <FloatingToolbar clip={clip} />
        </div>
      )}

      {/* Clip Content Rendering by Type */}
      <div className="w-full h-full rounded overflow-hidden relative flex flex-col justify-between">
        {/* VIDEO TRACK RENDERING */}
        {clip.type === 'video' && (
          <div className="w-full h-full bg-[#1e1e26] relative flex flex-col justify-between">
            {/* Filmstrip simulation thumbnails */}
            <div className="absolute inset-0 flex items-center gap-1.5 px-1 opacity-25 pointer-events-none overflow-hidden">
              {Array.from({ length: frameCount }).map((_, fIdx) => (
                <div
                  key={fIdx}
                  className="w-12 h-8 rounded-sm bg-gradient-to-br from-zinc-700 to-zinc-900 border border-zinc-600/40 flex items-center justify-center flex-shrink-0"
                >
                  <Video size={10} className="text-zinc-400 opacity-60" />
                </div>
              ))}
            </div>

            {/* Clip Label Header */}
            <div className="relative z-10 px-2 pt-1 flex items-center justify-between text-[11px] font-medium text-zinc-200">
              <div className="flex items-center gap-1.5 truncate">
                <Video size={12} className="text-blue-400 flex-shrink-0" />
                <span className="truncate drop-shadow-sm">{clip.content}</span>
              </div>
              <span className="text-[10px] font-mono text-zinc-400 flex-shrink-0 bg-black/40 px-1 py-0.2 rounded ml-1">
                {clip.duration.toFixed(1)}s
              </span>
            </div>

            {/* Bottom film perforations strip */}
            <div className="relative z-10 h-1.5 w-full bg-black/40 flex items-center justify-around px-1">
              {Array.from({ length: Math.max(3, Math.floor(widthPx / 16)) }).map((_, pIdx) => (
                <div key={pIdx} className="w-1 h-0.5 bg-zinc-600/60 rounded-xs" />
              ))}
            </div>
          </div>
        )}

        {/* AUDIO TRACK RENDERING */}
        {clip.type === 'audio' && (
          <div className="w-full h-full bg-[#063321] relative flex flex-col justify-between">
            {/* Top Label */}
            <div className="relative z-10 px-2 pt-1 flex items-center justify-between text-[11px] font-medium text-emerald-200">
              <div className="flex items-center gap-1.5 truncate">
                <Music size={12} className="text-emerald-400 flex-shrink-0" />
                <span className="truncate drop-shadow-sm">{clip.content}</span>
              </div>
              <span className="text-[10px] font-mono text-emerald-300 flex-shrink-0 bg-emerald-950/80 px-1 py-0.2 rounded border border-emerald-500/20 ml-1">
                {clip.duration.toFixed(1)}s
              </span>
            </div>

            {/* Audio Waveform SVG / Bars */}
            <div className="relative z-10 w-full h-7 px-1.5 flex items-center justify-between overflow-hidden">
              {waveformBars.map((normHeight, bIdx) => (
                <div
                  key={bIdx}
                  style={{
                    height: `${Math.round(normHeight * 22)}px`,
                  }}
                  className="w-[3px] bg-emerald-400/80 rounded-full flex-shrink-0 transition-all duration-75"
                />
              ))}
            </div>
          </div>
        )}

        {/* TEXT TRACK RENDERING */}
        {clip.type === 'text' && (
          <div className="w-full h-full bg-[#3b2308] relative flex items-center justify-between px-2.5">
            <div className="flex items-center gap-2 truncate">
              <div className="w-5 h-5 rounded bg-amber-500/20 border border-amber-500/40 flex items-center justify-center flex-shrink-0">
                <Type size={12} className="text-amber-300 font-bold" />
              </div>
              <span className="text-[11px] font-semibold text-amber-200 truncate">
                "{clip.content}"
              </span>
            </div>
            <span className="text-[10px] font-mono text-amber-400 bg-amber-950/80 px-1.5 py-0.5 rounded border border-amber-500/20 flex-shrink-0 ml-1">
              {clip.duration.toFixed(1)}s
            </span>
          </div>
        )}
      </div>

      {/* Trimming Left Handle (Shown when clip is selected) */}
      {isSelected && !isTrackLocked && (
        <div
          onPointerDown={handleLeftTrimPointerDown}
          className="trim-handle absolute left-0 top-0 bottom-0 w-2.5 bg-white hover:bg-zinc-200 cursor-ew-resize rounded-l flex items-center justify-center shadow-lg transition-colors z-30"
          title="Drag to trim start"
        >
          <GripVertical size={10} className="text-zinc-800" />
        </div>
      )}

      {/* Trimming Right Handle (Shown when clip is selected) */}
      {isSelected && !isTrackLocked && (
        <div
          onPointerDown={handleRightTrimPointerDown}
          className="trim-handle absolute right-0 top-0 bottom-0 w-2.5 bg-white hover:bg-zinc-200 cursor-ew-resize rounded-r flex items-center justify-center shadow-lg transition-colors z-30"
          title="Drag to trim end"
        >
          <GripVertical size={10} className="text-zinc-800" />
        </div>
      )}
    </div>
  );
}
