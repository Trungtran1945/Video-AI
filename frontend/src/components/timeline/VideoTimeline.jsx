import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Magnet,
  SkipBack,
  SkipForward,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useTimelineStore } from './timelineStore';
import { formatTimeCode } from './timelineUtils';
import TrackSidebar from './TrackSidebar';
import TimeRuler from './TimeRuler';
import TimelineClip from './TimelineClip';
import Playhead from './Playhead';

export default function VideoTimeline({
  currentTime: propCurrentTime,
  duration: propDuration = 0,
  isPlaying: propIsPlaying,
  playbackSpeed: propPlaybackSpeed,
  volume: propVolume,
  muted: propMuted,
  onSeek,
  onPlayPause,
  onSpeedChange,
  onVolumeChange,
  onMuteToggle,
  onSegmentClick,
  activeSegmentId = null,
  onClipsChange,
  transcript = null,
  project = null,
  outputUrl = null,
  className = '',
  minimized: propMinimized,
  onToggleMinimize: propOnToggleMinimize,
}) {
  const {
    currentTime: storeCurrentTime,
    setCurrentTime: setStoreCurrentTime,
    zoomLevel,
    setZoomLevel,
    tracks,
    clips,
    setClips,
    selectedClipId,
    setSelectedClipId,
    isPlaying: storeIsPlaying,
    togglePlayPause: toggleStorePlayPause,
    setIsPlaying: setStoreIsPlaying,
    snappingEnabled,
    toggleSnapping,
  } = useTimelineStore();

  const scrollContainerRef = useRef(null);

  // Timeline vertical resize
  const [timelineHeight, setTimelineHeight] = useState(() => {
    try {
      const saved = localStorage.getItem('timeline-height');
      return saved ? Math.max(120, Math.min(400, Number(saved))) : 180;
    } catch { return 180; }
  });
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef({ y: 0, height: 0 });

  // Minimized state (persisted in localStorage)
  const [internalMinimized, setInternalMinimized] = useState(() => {
    try {
      return localStorage.getItem('timeline-minimized') === 'true';
    } catch {
      return false;
    }
  });

  const isMinimized = propMinimized !== undefined ? propMinimized : internalMinimized;

  const toggleMinimize = useCallback(() => {
    if (propOnToggleMinimize) {
      propOnToggleMinimize(!isMinimized);
    } else {
      setInternalMinimized((prev) => {
        const next = !prev;
        try {
          localStorage.setItem('timeline-minimized', String(next));
        } catch {}
        return next;
      });
    }
  }, [propOnToggleMinimize, isMinimized]);

  const handleResizePointerDown = useCallback((e) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartRef.current = { y: e.clientY, height: timelineHeight };

    const onMove = (moveEvt) => {
      const delta = moveEvt.clientY - resizeStartRef.current.y;
      const newHeight = Math.max(120, Math.min(400, resizeStartRef.current.height + delta));
      setTimelineHeight(newHeight);
    };

    const onUp = () => {
      setIsResizing(false);
      try { localStorage.setItem('timeline-height', String(timelineHeight)); } catch {}
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [timelineHeight]);

  const isControlledPlayback = propIsPlaying !== undefined;

  // Use propCurrentTime directly as the single source of truth
  // ProjectDetail pushes video.currentTime into the Zustand store via RAF loop
  const activeCurrentTime = propCurrentTime;
  const activeIsPlaying = isControlledPlayback ? propIsPlaying : storeIsPlaying;

  // Sync transcript and video duration into clips
  useEffect(() => {
    if (transcript === null && !outputUrl && propDuration === 0) return;

    const newClips = [];

    // Video reference layer
    if (propDuration > 0) {
      newClips.push({
        id: 'clip-video-main',
        trackId: 'track-video-1',
        start: 0,
        duration: Number(propDuration.toFixed(2)),
        type: 'video',
        content: project?.title || 'Video Output',
        color: '#27272a',
      });
    }

    // Original language layer (read-only timing from transcript)
    if (Array.isArray(transcript) && transcript.length > 0) {
      transcript.forEach((seg, idx) => {
        const startSec = Number(seg.startSec ?? seg.start_sec) || 0;
        const endSec = Number(seg.endSec ?? seg.end_sec) || startSec + 1;
        const dur = Math.max(0.1, Number((endSec - startSec).toFixed(2)));

        newClips.push({
          id: `orig-${seg.id || idx}`,
          segmentId: seg.id,
          trackId: 'track-original-1',
          start: startSec,
          duration: dur,
          type: 'original',
          content: seg.text || '',
          color: '#78350f',
          speaker: seg.speaker,
        });
      });

      // Translated language layer (independent, user-editable timing)
      transcript.forEach((seg, idx) => {
        const startSec = Number(seg.startSec ?? seg.start_sec) || 0;
        const endSec = Number(seg.endSec ?? seg.end_sec) || startSec + 1;
        const dur = Math.max(0.1, Number((endSec - startSec).toFixed(2)));

        newClips.push({
          id: `trans-${seg.id || idx}`,
          segmentId: seg.id,
          trackId: 'track-translated-1',
          start: startSec,
          duration: dur,
          type: 'translated',
          content: seg.translation || seg.text || '',
          color: '#064e3b',
          speaker: seg.speaker,
        });
      });
    }

    setClips(newClips);
  }, [transcript, propDuration, outputUrl, project?.title, setClips]);

  // Notify parent on clips update
  useEffect(() => {
    onClipsChange?.(clips);
  }, [clips, onClipsChange]);

  const handleSeek = (newTime) => {
    const clamped = Math.max(0, Number(newTime.toFixed(3)));
    setStoreCurrentTime(clamped);
    onSeek?.(clamped);
  };

  const handleTogglePlay = () => {
    if (onPlayPause) {
      onPlayPause();
    } else {
      toggleStorePlayPause();
    }
  };

  // Calculate total timeline duration
  const totalDuration = useMemo(() => {
    let maxTime = propDuration > 0 ? propDuration : 35;
    clips.forEach((c) => {
      const end = c.start + c.duration;
      if (end + 10 > maxTime) {
        maxTime = end + 10;
      }
    });
    return Math.max(maxTime, activeCurrentTime + 5, 20);
  }, [clips, activeCurrentTime, propDuration]);

  const totalContentWidth = Math.max(1200, Math.ceil(totalDuration * zoomLevel));
  const tracksHeight = tracks.length * 56;
  const totalRulerAndTracksHeight = tracksHeight + 36;

  // Global Keyboard Shortcuts (Space: Play/Pause, Arrow: scrub)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleSeek(Math.max(0, activeCurrentTime - (e.shiftKey ? 1 : 0.1)));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleSeek(activeCurrentTime + (e.shiftKey ? 1 : 0.1));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeCurrentTime, handleSeek, handleTogglePlay]);

  const handleTimelineBackgroundClick = (e) => {
    if (e.target.classList.contains('track-row') || e.target.classList.contains('tracks-canvas')) {
      setSelectedClipId(null);
    }
  };

  return (
    <div
      className={`flex flex-col bg-card text-foreground rounded-xl border border-border shadow-2xl overflow-hidden select-none font-sans ${className}`}
    >
      {/* Timeline Header & Controls */}
      <div
        className={`px-4 bg-muted/40 dark:bg-card flex items-center justify-between z-30 transition-all ${
          isMinimized ? 'h-10' : 'h-12 border-b border-border'
        }`}
      >
        {/* Left: Timecode + Play Controls */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 bg-background border border-border px-2.5 py-1 rounded-lg shadow-inner">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            <span className="font-mono text-xs font-semibold tracking-wider text-foreground">
              {formatTimeCode(activeCurrentTime)}
            </span>
            <span className="text-muted-foreground text-[10px]">/</span>
            <span className="font-mono text-xs text-muted-foreground">
              {formatTimeCode(propDuration > 0 ? propDuration : totalDuration)}
            </span>
          </div>

          <button
            type="button"
            onClick={() => handleSeek(0)}
            title="Jump to Start"
            aria-label="Về đầu video"
            className="p-1.5 rounded-lg bg-background hover:bg-muted text-muted-foreground hover:text-foreground border border-border/60 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <RotateCcw size={13} />
          </button>

          <button
            type="button"
            onClick={() => handleSeek(Math.max(0, activeCurrentTime - 5))}
            title="Seek Backward 5s"
            aria-label="Lùi lại 5 giây"
            className="p-1.5 rounded-lg bg-background hover:bg-muted text-muted-foreground hover:text-foreground border border-border/60 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <SkipBack size={13} />
          </button>

          <button
            type="button"
            onClick={handleTogglePlay}
            title={activeIsPlaying ? 'Pause (Space)' : 'Play (Space)'}
            aria-label={activeIsPlaying ? 'Tạm dừng video' : 'Phát video'}
            className={`px-3 py-1 rounded-lg flex items-center gap-1 font-semibold text-xs transition-all shadow-xs active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              activeIsPlaying
                ? 'bg-amber-500 hover:bg-amber-400 text-black'
                : 'bg-primary hover:bg-primary/90 text-primary-foreground'
            }`}
          >
            {activeIsPlaying ? <Pause size={12} /> : <Play size={12} className="fill-current" />}
            <span>{activeIsPlaying ? 'Pause' : 'Play'}</span>
          </button>

          <button
            type="button"
            onClick={() => handleSeek(Math.min(activeCurrentTime + 5, propDuration || totalDuration))}
            title="Seek Forward 5s"
            aria-label="Tiến tới 5 giây"
            className="p-1.5 rounded-lg bg-background hover:bg-muted text-muted-foreground hover:text-foreground border border-border/60 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <SkipForward size={13} />
          </button>
        </div>

        {/* Center: Snapping Toggle (only shown when expanded) */}
        {!isMinimized && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleSnapping}
              title="Toggle snapping to time anchors"
              aria-label="Bật tắt tính năng hít dính mốc thời gian"
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                snappingEnabled
                  ? 'bg-primary/10 border-primary/40 text-primary shadow-xs'
                  : 'bg-background hover:bg-muted border-border/60 text-muted-foreground hover:text-foreground'
              }`}
            >
              <Magnet size={12} className={snappingEnabled ? 'text-primary' : ''} />
              <span>Snapping: {snappingEnabled ? 'ON' : 'OFF'}</span>
            </button>
          </div>
        )}

        {/* Right: Zoom + Minimize Button (expanded) OR Expand Button (minimized) */}
        <div className="flex items-center gap-2">
          {!isMinimized ? (
            <>
              <button
                type="button"
                onClick={() => setZoomLevel(zoomLevel - 10)}
                title="Zoom Out"
                aria-label="Thu nhỏ timeline"
                className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <ZoomOut size={14} />
              </button>

              <input
                type="range"
                min={20}
                max={150}
                value={zoomLevel}
                onChange={(e) => setZoomLevel(Number(e.target.value))}
                aria-label="Mức độ thu phóng timeline"
                className="w-20 h-1.5 bg-muted dark:bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-primary"
                title={`Zoom: ${zoomLevel}px/sec`}
              />

              <button
                type="button"
                onClick={() => setZoomLevel(zoomLevel + 10)}
                title="Zoom In"
                aria-label="Phóng to timeline"
                className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <ZoomIn size={14} />
              </button>

              <span className="font-mono text-[10px] text-muted-foreground w-10 text-right">
                {Math.round((zoomLevel / 50) * 100)}%
              </span>

              <div className="h-4 w-px bg-border mx-1" />

              <button
                type="button"
                onClick={toggleMinimize}
                title="Thu gọn Timeline (ẩn track dựng)"
                aria-label="Thu gọn timeline"
                className="p-1.5 rounded-lg bg-background hover:bg-muted text-muted-foreground hover:text-foreground border border-border/60 transition-colors flex items-center gap-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <ChevronDown size={14} />
                <span className="text-[11px] font-medium hidden sm:inline">Thu gọn</span>
              </button>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground hidden sm:inline">Bản dựng đang thu gọn</span>
              <button
                type="button"
                onClick={toggleMinimize}
                title="Mở rộng Timeline"
                aria-label="Mở rộng timeline"
                className="px-2.5 py-1 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 transition-colors flex items-center gap-1.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <ChevronUp size={14} />
                <span>Mở rộng Timeline</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {!isMinimized && (
        <>
          {/* Main Timeline Body */}
          <div
            className="flex flex-1 overflow-hidden relative bg-muted/20 dark:bg-[#0c0c0e]"
            style={{ height: `${timelineHeight}px` }}
          >
            <TrackSidebar />

            <div
              ref={scrollContainerRef}
              className="timeline-scroll-container flex-1 overflow-x-auto overflow-y-hidden relative bg-background dark:bg-[#0f0f12] cursor-default"
              style={{ height: `${totalRulerAndTracksHeight}px` }}
              onClick={handleTimelineBackgroundClick}
            >
              <div
                className="tracks-canvas relative"
                style={{
                  width: `${totalContentWidth}px`,
                  height: `${totalRulerAndTracksHeight}px`,
                }}
              >
                <TimeRuler totalDuration={totalDuration} onSeek={handleSeek} />
                <Playhead height={totalRulerAndTracksHeight} onSeek={handleSeek} />

                <div className="relative flex flex-col">
                  {tracks.map((track) => {
                    const trackClips = clips.filter((c) => c.trackId === track.id);

                    return (
                      <div
                        key={track.id}
                        className="track-row relative h-14 border-b border-border/50 bg-card/60 hover:bg-muted/30 dark:bg-[#121216]/50 dark:hover:bg-[#14141a]/60 transition-colors"
                        onClick={handleTimelineBackgroundClick}
                      >
                        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(0,0,0,0.03)_1px,transparent_1px)] dark:bg-[linear-gradient(to_right,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:50px_100%] pointer-events-none" />

                        {trackClips.map((clip) => (
                          <TimelineClip
                            key={clip.id}
                            clip={clip}
                            isTrackLocked={track.isLocked}
                            onSegmentClick={onSegmentClick}
                            isActive={clip.segmentId === activeSegmentId || clip.id === activeSegmentId}
                          />
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Vertical Resize Handle */}
          <div
            onPointerDown={handleResizePointerDown}
            className={`h-1.5 cursor-ns-resize flex items-center justify-center group/resizet transition-colors border-t border-border/40 ${
              isResizing ? 'bg-primary/30' : 'bg-transparent hover:bg-primary/10'
            }`}
            title="Drag to resize timeline"
          >
            <div className={`w-8 h-0.5 rounded-full transition-colors ${
              isResizing ? 'bg-primary' : 'bg-muted-foreground/40 group-hover/resizet:bg-muted-foreground'
            }`} />
          </div>

          {/* Footer */}
          <div className="h-7 px-4 bg-muted/40 dark:bg-card/90 border-t border-border flex items-center justify-between text-[10px] text-muted-foreground">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.2 bg-background border border-border rounded text-[9px] font-mono text-foreground">
                  Space
                </kbd>
                <span>Play/Pause</span>
              </span>

              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.2 bg-background border border-border rounded text-[9px] font-mono text-foreground">
                  ←/→
                </kbd>
                <span>Scrub</span>
              </span>
            </div>

            <div className="flex items-center gap-1.5 text-muted-foreground">
              <span>Subtitle Sync</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
