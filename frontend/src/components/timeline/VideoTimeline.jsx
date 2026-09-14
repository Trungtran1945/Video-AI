import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Magnet,
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

  const activeCurrentTime = storeCurrentTime;
  const activeIsPlaying = isControlledPlayback ? propIsPlaying : storeIsPlaying;

  // Sync external currentTime into store
  useEffect(() => {
    if (propCurrentTime !== undefined && Math.abs(propCurrentTime - storeCurrentTime) > 0.05) {
      setStoreCurrentTime(propCurrentTime);
    }
  }, [propCurrentTime, storeCurrentTime, setStoreCurrentTime]);

  // Smooth playhead sync via RAF during controlled playback
  useEffect(() => {
    if (!isControlledPlayback || !activeIsPlaying) return;
    let rafId;
    const syncLoop = () => {
      const video = document.getElementById('output-video');
      if (video && !video.paused) {
        const t = video.currentTime;
        setStoreCurrentTime(t);
      }
      rafId = requestAnimationFrame(syncLoop);
    };
    rafId = requestAnimationFrame(syncLoop);
    return () => cancelAnimationFrame(rafId);
  }, [isControlledPlayback, activeIsPlaying, setStoreCurrentTime]);

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

  // Internal Playback Loop only when uncontrolled
  useEffect(() => {
    if (isControlledPlayback || !activeIsPlaying) return;

    let animationFrameId;
    let lastTime = performance.now();

    const loop = (now) => {
      const deltaSec = (now - lastTime) / 1000;
      lastTime = now;

      const nextTime = useTimelineStore.getState().currentTime + deltaSec;
      if (nextTime >= totalDuration) {
        handleSeek(0);
        setStoreIsPlaying(false);
      } else {
        handleSeek(nextTime);
        animationFrameId = requestAnimationFrame(loop);
      }
    };

    animationFrameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationFrameId);
  }, [isControlledPlayback, activeIsPlaying, totalDuration, setStoreIsPlaying, handleSeek]);

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
      className={`flex flex-col bg-[#0f0f11] text-zinc-100 rounded-xl border border-white/10 shadow-2xl overflow-hidden select-none font-sans ${className}`}
    >
      {/* Timeline Header & Controls */}
      <div className="h-12 px-4 bg-[#141418] border-b border-white/10 flex items-center justify-between z-30">
        {/* Left: Timecode + Play Controls */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 bg-[#09090c] border border-white/10 px-2.5 py-1 rounded-lg shadow-inner">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            <span className="font-mono text-xs font-semibold tracking-wider text-white">
              {formatTimeCode(activeCurrentTime)}
            </span>
            <span className="text-zinc-500 text-[10px]">/</span>
            <span className="font-mono text-xs text-zinc-400">
              {formatTimeCode(propDuration > 0 ? propDuration : totalDuration)}
            </span>
          </div>

          <button
            type="button"
            onClick={() => handleSeek(0)}
            title="Jump to Start"
            className="p-1.5 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-300 hover:text-white transition-colors"
          >
            <RotateCcw size={13} />
          </button>

          <button
            type="button"
            onClick={handleTogglePlay}
            title={activeIsPlaying ? 'Pause (Space)' : 'Play (Space)'}
            className={`px-3 py-1 rounded-lg flex items-center gap-1 font-medium text-xs transition-all shadow-md active:scale-95 ${
              activeIsPlaying
                ? 'bg-amber-500 hover:bg-amber-400 text-black font-semibold'
                : 'bg-white hover:bg-zinc-200 text-zinc-950 font-semibold'
            }`}
          >
            {activeIsPlaying ? <Pause size={12} /> : <Play size={12} className="fill-current" />}
            <span>{activeIsPlaying ? 'Pause' : 'Play'}</span>
          </button>
        </div>

        {/* Center: Snapping Toggle */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleSnapping}
            title="Toggle snapping to time anchors"
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
              snappingEnabled
                ? 'bg-blue-500/15 border-blue-500/40 text-blue-400 shadow-sm'
                : 'bg-zinc-800/40 border-zinc-700/40 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Magnet size={12} className={snappingEnabled ? 'text-blue-400' : ''} />
            <span>Snapping: {snappingEnabled ? 'ON' : 'OFF'}</span>
          </button>
        </div>

        {/* Right: Zoom */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setZoomLevel(zoomLevel - 10)}
            title="Zoom Out"
            className="text-zinc-400 hover:text-white transition-colors"
          >
            <ZoomOut size={14} />
          </button>

          <input
            type="range"
            min={20}
            max={150}
            value={zoomLevel}
            onChange={(e) => setZoomLevel(Number(e.target.value))}
            className="w-20 h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            title={`Zoom: ${zoomLevel}px/sec`}
          />

          <button
            type="button"
            onClick={() => setZoomLevel(zoomLevel + 10)}
            title="Zoom In"
            className="text-zinc-400 hover:text-white transition-colors"
          >
            <ZoomIn size={14} />
          </button>

          <span className="font-mono text-[10px] text-zinc-400 w-10 text-right">
            {Math.round((zoomLevel / 50) * 100)}%
          </span>
        </div>
      </div>

      {/* Main Timeline Body */}
      <div
        className="flex flex-1 overflow-hidden relative bg-[#0c0c0e]"
        style={{ height: `${timelineHeight}px` }}
      >
        <TrackSidebar />

        <div
          ref={scrollContainerRef}
          className="timeline-scroll-container flex-1 overflow-x-auto overflow-y-hidden relative bg-[#0f0f12] cursor-default"
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
                    className="track-row relative h-14 border-b border-white/5 bg-[#121216]/50 hover:bg-[#14141a]/60 transition-colors"
                    onClick={handleTimelineBackgroundClick}
                  >
                    <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff03_1px,transparent_1px)] bg-[size:50px_100%] pointer-events-none" />

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
        className={`h-1.5 cursor-ns-resize flex items-center justify-center group/resizet transition-colors ${
          isResizing ? 'bg-blue-500/30' : 'bg-transparent hover:bg-blue-500/20'
        }`}
        title="Drag to resize timeline"
      >
        <div className={`w-8 h-0.5 rounded-full transition-colors ${
          isResizing ? 'bg-blue-400' : 'bg-zinc-600 group-hover/resizet:bg-zinc-400'
        }`} />
      </div>

      {/* Footer */}
      <div className="h-7 px-4 bg-[#0a0a0d] border-t border-white/10 flex items-center justify-between text-[10px] text-zinc-500">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.2 bg-zinc-800 border border-zinc-700 rounded text-[9px] font-mono text-zinc-300">
              Space
            </kbd>
            <span>Play/Pause</span>
          </span>

          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.2 bg-zinc-800 border border-zinc-700 rounded text-[9px] font-mono text-zinc-300">
              ←/→
            </kbd>
            <span>Scrub</span>
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-zinc-500">
          <span>Subtitle Sync</span>
        </div>
      </div>
    </div>
  );
}
