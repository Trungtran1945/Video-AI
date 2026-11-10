import React, { useState, useRef } from 'react';
import { Type, GripVertical, Film, Video, Zap, Sparkles, AlertTriangle, Loader2, Image as ImageIcon, Layers, Mic, Music } from 'lucide-react';
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

  const clipType = clip.clip_type || clip.type;
  const isEditable = clipType === 'translated' || clip.editable === true || ['background', 'video', 'image', 'voiceover', 'music', 'text'].includes(clipType);

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
    e.preventDefault();
    if (!isEditable || isTrackLocked) return;

    setSelectedClipId(clip.id);
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
    e.preventDefault();
    if (!isEditable || isTrackLocked) return;

    setSelectedClipId(clip.id);
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

  // Video track: simple reference bar (legacy TRANSLATE_DUB read-only track)
  if (clip.type === 'video' && !clip.trackId && !clip.track_id && !clip.assetId && !clip.asset_id && !clip.editable && !clip.clip_type) {
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

  // Color & Icon Configuration based on Clip Type
  let bgColor = 'bg-emerald-50 dark:bg-[#063321]';
  let borderColor = 'border-emerald-300 dark:border-emerald-500/30';
  let textColor = 'text-emerald-900 dark:text-emerald-200';
  let badgeColor = 'text-emerald-800 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-950/80 border-emerald-300 dark:border-emerald-500/20';
  let iconBg = 'bg-emerald-100 dark:bg-emerald-500/20 border-emerald-300 dark:border-emerald-500/40';
  let iconColor = 'text-emerald-700 dark:text-emerald-300';
  let ClipIcon = Type;

  if (clipType === 'original') {
    bgColor = 'bg-amber-50 dark:bg-[#3b2308]';
    borderColor = 'border-amber-300 dark:border-amber-500/30';
    textColor = 'text-amber-900 dark:text-amber-200';
    badgeColor = 'text-amber-800 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/80 border-amber-300 dark:border-amber-500/20';
    iconBg = 'bg-amber-100 dark:bg-amber-500/20 border-amber-300 dark:border-amber-500/40';
    iconColor = 'text-amber-700 dark:text-amber-300';
    ClipIcon = Type;
  } else if (clipType === 'background') {
    bgColor = 'bg-purple-50 dark:bg-[#27173e]';
    borderColor = 'border-purple-300 dark:border-purple-500/30';
    textColor = 'text-purple-900 dark:text-purple-200';
    badgeColor = 'text-purple-800 dark:text-purple-400 bg-purple-100 dark:bg-purple-950/80 border-purple-300 dark:border-purple-500/20';
    iconBg = 'bg-purple-100 dark:bg-purple-500/20 border-purple-300 dark:border-purple-500/40';
    iconColor = 'text-purple-700 dark:text-purple-300';
    ClipIcon = Layers;
  } else if (clipType === 'video') {
    bgColor = 'bg-blue-50 dark:bg-[#0c2340]';
    borderColor = 'border-blue-300 dark:border-blue-500/30';
    textColor = 'text-blue-900 dark:text-blue-200';
    badgeColor = 'text-blue-800 dark:text-blue-400 bg-blue-100 dark:bg-blue-950/80 border-blue-300 dark:border-blue-500/20';
    iconBg = 'bg-blue-100 dark:bg-blue-500/20 border-blue-300 dark:border-blue-500/40';
    iconColor = 'text-blue-700 dark:text-blue-300';
    ClipIcon = Video;
  } else if (clipType === 'image') {
    bgColor = 'bg-cyan-50 dark:bg-[#0c2e35]';
    borderColor = 'border-cyan-300 dark:border-cyan-500/30';
    textColor = 'text-cyan-900 dark:text-cyan-200';
    badgeColor = 'text-cyan-800 dark:text-cyan-400 bg-cyan-100 dark:bg-cyan-950/80 border-cyan-300 dark:border-cyan-500/20';
    iconBg = 'bg-cyan-100 dark:bg-cyan-500/20 border-cyan-300 dark:border-cyan-500/40';
    iconColor = 'text-cyan-700 dark:text-cyan-300';
    ClipIcon = ImageIcon;
  } else if (clipType === 'voiceover') {
    bgColor = 'bg-rose-50 dark:bg-[#38141f]';
    borderColor = 'border-rose-300 dark:border-rose-500/30';
    textColor = 'text-rose-900 dark:text-rose-200';
    badgeColor = 'text-rose-800 dark:text-rose-400 bg-rose-100 dark:bg-rose-950/80 border-rose-300 dark:border-rose-500/20';
    iconBg = 'bg-rose-100 dark:bg-rose-500/20 border-rose-300 dark:border-rose-500/40';
    iconColor = 'text-rose-700 dark:text-rose-300';
    ClipIcon = Mic;
  } else if (clipType === 'music') {
    bgColor = 'bg-amber-50 dark:bg-[#342409]';
    borderColor = 'border-amber-300 dark:border-amber-500/30';
    textColor = 'text-amber-900 dark:text-amber-200';
    badgeColor = 'text-amber-800 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/80 border-amber-300 dark:border-amber-500/20';
    iconBg = 'bg-amber-100 dark:bg-amber-500/20 border-amber-300 dark:border-amber-500/40';
    iconColor = 'text-amber-700 dark:text-amber-300';
    ClipIcon = Music;
  }

  const displayContent = clip.textContent || clip.text_content || clip.content || (clip.meta && typeof clip.meta === 'object' ? clip.meta.name : '') || clip.name || clipType;

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
      {/* B2: track locked (detail readOnly) → ẩn toolbar xóa local-only */}
      {isSelected && isEditable && !isTrackLocked && !isDraggingClip && !isTrimming && (
        <div className="floating-toolbar">
          <FloatingToolbar clip={clip} />
        </div>
      )}

      <div className={`w-full h-full rounded overflow-hidden relative flex items-center justify-between px-2.5 ${bgColor}`}>
        <div className="flex items-center gap-2 truncate">
          {clip.thumbnailUrl ? (
            <img
              src={clip.thumbnailUrl}
              alt=""
              className="w-5 h-5 rounded object-cover border border-border shrink-0"
            />
          ) : (
            <div className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 ${iconBg}`}>
              <ClipIcon size={12} className={`font-bold ${iconColor}`} />
            </div>
          )}
          <span className={`text-[11px] font-semibold truncate ${textColor}`}>
            {displayContent}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-1">
          {clip.processing && (
            <span title="Đang xử lý segment" className="flex items-center text-blue-500">
              <Loader2 size={11} className="animate-spin" />
            </span>
          )}
          {clip.cached && !clip.processing && (
            <span title="Tái sử dụng artifact (Cache)" className="inline-flex items-center text-emerald-600 dark:text-emerald-400">
              <Zap size={11} />
            </span>
          )}
          {clip.repaired && !clip.processing && (
            <span title="Đã sửa ngữ nghĩa" className="inline-flex items-center text-purple-600 dark:text-purple-400">
              <Sparkles size={11} />
            </span>
          )}
          {clip.warning && !clip.processing && (
            <span title="Cần lưu ý số liệu/ngữ nghĩa" className="inline-flex items-center text-amber-600 dark:text-amber-400">
              <AlertTriangle size={11} />
            </span>
          )}
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border flex-shrink-0 ${badgeColor}`}>
            {clip.duration.toFixed(1)}s
          </span>
        </div>
      </div>

      {isEditable && !isTrackLocked && (
        <div
          onPointerDown={handleLeftTrimPointerDown}
          className={`trim-handle absolute left-0 top-0 bottom-0 w-3 cursor-ew-resize rounded-l items-center justify-center shadow-xs transition-all z-30 ${
            isSelected || isTrimming
              ? 'flex bg-primary border-r border-primary/50 text-primary-foreground'
              : 'hidden group-hover:flex bg-card/90 hover:bg-primary/20 border border-border text-foreground'
          }`}
          title="Kéo để chỉnh thời điểm bắt đầu (Trim start)"
        >
          <GripVertical size={10} className={isSelected || isTrimming ? 'text-white' : 'text-primary'} />
        </div>
      )}

      {isEditable && !isTrackLocked && (
        <div
          onPointerDown={handleRightTrimPointerDown}
          className={`trim-handle absolute right-0 top-0 bottom-0 w-3 cursor-ew-resize rounded-r items-center justify-center shadow-xs transition-all z-30 ${
            isSelected || isTrimming
              ? 'flex bg-primary border-l border-primary/50 text-primary-foreground'
              : 'hidden group-hover:flex bg-card/90 hover:bg-primary/20 border border-border text-foreground'
          }`}
          title="Kéo để chỉnh thời lượng (Trim end)"
        >
          <GripVertical size={10} className={isSelected || isTrimming ? 'text-white' : 'text-primary'} />
        </div>
      )}
    </div>
  );
}
