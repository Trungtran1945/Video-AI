import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Magnet,
  Plus,
  ChevronRight,
  ChevronLeft,
  Link,
  Unlink,
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
    autoSnapEdges,
    toggleAutoSnapEdges,
    splitClip,
    deleteClip,
    addTrack,
  } = useTimelineStore();

  const scrollContainerRef = useRef(null);

  // Timeline vertical resize
  const [timelineHeight, setTimelineHeight] = useState(() => {
    try {
      const saved = localStorage.getItem('timeline-height');
      return saved ? Math.max(120, Math.min(600, Number(saved))) : 200;
    } catch { return 200; }
  });
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef({ y: 0, height: 0 });

  const handleResizePointerDown = useCallback((e) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartRef.current = { y: e.clientY, height: timelineHeight };

    const onMove = (moveEvt) => {
      const delta = moveEvt.clientY - resizeStartRef.current.y;
      const newHeight = Math.max(120, Math.min(600, resizeStartRef.current.height + delta));
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
  const isControlledTime = propCurrentTime !== undefined;

  const activeCurrentTime = storeCurrentTime;
  const activeIsPlaying = isControlledPlayback ? propIsPlaying : storeIsPlaying;

  // Sync external currentTime into store if changed externally
  useEffect(() => {
    if (propCurrentTime !== undefined && Math.abs(propCurrentTime - storeCurrentTime) > 0.05) {
      setStoreCurrentTime(propCurrentTime);
    }
  }, [propCurrentTime, storeCurrentTime, setStoreCurrentTime]);

  // Smooth playhead sync via RAF during controlled playback (bypasses timeupdate throttling)
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

  // Sync transcript and video duration into clips without mock data
  useEffect(() => {
    // Only synchronize if transcript or outputUrl is explicitly passed from parent
    if (transcript === null && !outputUrl && propDuration === 0) return;

    const newClips = [];

    // 1. Video track clip representing actual project video (if output exists & duration > 0)
    if (propDuration > 0) {
      newClips.push({
        id: 'clip-video-main',
        trackId: 'track-video-1',
        start: 0,
        duration: Number(propDuration.toFixed(2)),
        type: 'video',
        content: project?.title || 'Video_Output.mp4',
        color: '#27272a',
      });
    }

    // 2. Subtitle / Text track clips populated from real transcript segments
    if (Array.isArray(transcript) && transcript.length > 0) {
      transcript.forEach((seg, idx) => {
        const startSec = Number(seg.startSec ?? seg.start_sec) || 0;
        const endSec = Number(seg.endSec ?? seg.end_sec) || startSec + 1;
        const dur = Math.max(0.1, Number((endSec - startSec).toFixed(2)));

        newClips.push({
          id: `sub-${seg.id || idx}`,
          segmentId: seg.id,
          trackId: 'track-text-1',
          start: startSec,
          duration: dur,
          type: 'text',
          content: seg.text || '',
          color: '#78350f',
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

  // Calculate total timeline duration based on clips + padding
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
  const tracksHeight = tracks.length * 56; // 56px per track
  const totalRulerAndTracksHeight = tracksHeight + 36; // 36px ruler

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

  // Global Keyboard Shortcuts (Space: Play/Pause, S: Split, Del: Delete)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.key === 's' || e.key === 'S') {
        if (selectedClipId) {
          e.preventDefault();
          splitClip(selectedClipId, activeCurrentTime);
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedClipId) {
          e.preventDefault();
          deleteClip(selectedClipId);
        }
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
  }, [selectedClipId, activeCurrentTime, splitClip, deleteClip, handleSeek, handleTogglePlay]);

  const handleTimelineBackgroundClick = (e) => {
    if (e.target.classList.contains('track-row') || e.target.classList.contains('tracks-canvas')) {
      setSelectedClipId(null);
    }
  };

  return (
    <div
      className={`flex flex-col bg-[#0f0f11] text-zinc-100 rounded-xl border border-white/10 shadow-2xl overflow-hidden select-none font-sans ${className}`}
    >
      {/* 1. TOP TIMELINE HEADER & CONTROLS */}
      <div className="h-14 px-4 bg-[#141418] border-b border-white/10 flex items-center justify-between z-30">
        {/* Left: Timecode Display & Quick Navigation */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-[#09090c] border border-white/10 px-3 py-1.5 rounded-lg shadow-inner">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="font-mono text-sm font-semibold tracking-wider text-white">
              {formatTimeCode(activeCurrentTime)}
            </span>
            <span className="text-zinc-500 text-xs">/</span>
            <span className="font-mono text-sm text-zinc-400">
              {formatTimeCode(propDuration > 0 ? propDuration : totalDuration)}
            </span>
          </div>

          {/* Jump to Beginning */}
          <button
            type="button"
            onClick={() => handleSeek(0)}
            title="Jump to Start"
            className="p-2 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-300 hover:text-white transition-colors"
          >
            <RotateCcw size={15} />
          </button>

          {/* Step Backward 1s */}
          <button
            type="button"
            onClick={() => handleSeek(Math.max(0, activeCurrentTime - 1))}
            title="Step Back 1s (Left Arrow)"
            className="p-2 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-300 hover:text-white transition-colors"
          >
            <ChevronLeft size={15} />
          </button>

          {/* Play / Pause Primary Button */}
          <button
            type="button"
            onClick={handleTogglePlay}
            title={activeIsPlaying ? 'Pause (Space)' : 'Play (Space)'}
            className={`px-4 py-1.5 rounded-lg flex items-center gap-1.5 font-medium text-xs transition-all shadow-md active:scale-95 ${
              activeIsPlaying
                ? 'bg-amber-500 hover:bg-amber-400 text-black font-semibold'
                : 'bg-white hover:bg-zinc-200 text-zinc-950 font-semibold'
            }`}
          >
            {activeIsPlaying ? <Pause size={14} /> : <Play size={14} className="fill-current" />}
            <span>{activeIsPlaying ? 'Pause' : 'Play'}</span>
          </button>

          {/* Step Forward 1s */}
          <button
            type="button"
            onClick={() => handleSeek(activeCurrentTime + 1)}
            title="Step Forward 1s (Right Arrow)"
            className="p-2 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-300 hover:text-white transition-colors"
          >
            <ChevronRight size={15} />
          </button>
        </div>

        {/* Center: Magnetic Snapping & Add Track */}
        <div className="flex items-center gap-2">
          {/* Magnetic Snapping Toggle */}
          <button
            type="button"
            onClick={toggleSnapping}
            title="Magnetic Snapping (Snaps clips to playhead & edges within 10px)"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              snappingEnabled
                ? 'bg-blue-500/15 border-blue-500/40 text-blue-400 shadow-sm'
                : 'bg-zinc-800/40 border-zinc-700/40 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Magnet size={13} className={snappingEnabled ? 'text-blue-400' : ''} />
            <span>Snapping: {snappingEnabled ? 'ON' : 'OFF'}</span>
          </button>

          {/* Auto-Snap Edges Toggle (layers stick together) */}
          <button
            type="button"
            onClick={toggleAutoSnapEdges}
            title="Gắn liền các layer cùng hàng (tự động khít liền kề)"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              autoSnapEdges
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400 shadow-sm'
                : 'bg-zinc-800/40 border-zinc-700/40 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {autoSnapEdges ? <Link size={13} className="text-emerald-400" /> : <Unlink size={13} />}
            <span>Gắn liền: {autoSnapEdges ? 'ON' : 'OFF'}</span>
          </button>

          {/* Add Track Actions */}
          <div className="hidden sm:flex items-center bg-[#09090c] border border-white/10 rounded-lg p-0.5">
            <button
              type="button"
              onClick={() => addTrack('video')}
              title="Add Video Track"
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-zinc-300 hover:text-white hover:bg-white/10 transition-colors"
            >
              <Plus size={11} className="text-blue-400" />
              <span>Video</span>
            </button>
            <div className="w-[1px] h-3 bg-white/10" />
            <button
              type="button"
              onClick={() => addTrack('audio')}
              title="Add Audio Track"
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-zinc-300 hover:text-white hover:bg-white/10 transition-colors"
            >
              <Plus size={11} className="text-emerald-400" />
              <span>Audio</span>
            </button>
            <div className="w-[1px] h-3 bg-white/10" />
            <button
              type="button"
              onClick={() => addTrack('text')}
              title="Add Text Track"
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-zinc-300 hover:text-white hover:bg-white/10 transition-colors"
            >
              <Plus size={11} className="text-amber-400" />
              <span>Text</span>
            </button>
          </div>
        </div>

        {/* Right: Zoom Level Slider */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setZoomLevel(zoomLevel - 10)}
            title="Zoom Out"
            className="text-zinc-400 hover:text-white transition-colors"
          >
            <ZoomOut size={15} />
          </button>

          {/* Zoom Slider */}
          <input
            type="range"
            min={20}
            max={150}
            value={zoomLevel}
            onChange={(e) => setZoomLevel(Number(e.target.value))}
            className="w-24 sm:w-28 h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            title={`Zoom: ${zoomLevel}px/sec`}
          />

          <button
            type="button"
            onClick={() => setZoomLevel(zoomLevel + 10)}
            title="Zoom In"
            className="text-zinc-400 hover:text-white transition-colors"
          >
            <ZoomIn size={15} />
          </button>

          <span className="font-mono text-[11px] text-zinc-400 w-12 text-right">
            {Math.round((zoomLevel / 50) * 100)}%
          </span>
        </div>
      </div>

      {/* 2. MAIN TIMELINE BODY (Left Sidebar + Right Horizontally Scrollable Track Canvas) */}
      <div
        className="flex flex-1 overflow-hidden relative bg-[#0c0c0e]"
        style={{ height: `${timelineHeight}px` }}
      >
        {/* Left Sidebar (Fixed Width ~72px) with Track Controls */}
        <TrackSidebar />

        {/* Right Area (Horizontally Scrollable) */}
        <div
          ref={scrollContainerRef}
          className="timeline-scroll-container flex-1 overflow-x-auto overflow-y-hidden relative bg-[#0f0f12] cursor-default"
          style={{ height: `${totalRulerAndTracksHeight}px` }}
          onClick={handleTimelineBackgroundClick}
        >
          {/* Scrollable Canvas Container */}
          <div
            className="tracks-canvas relative"
            style={{
              width: `${totalContentWidth}px`,
              height: `${totalRulerAndTracksHeight}px`,
            }}
          >
            {/* Sticky Time Ruler */}
            <TimeRuler totalDuration={totalDuration} onSeek={handleSeek} />

            {/* Absolute Playhead & Magnetic Snap Guide Line */}
            <Playhead height={totalRulerAndTracksHeight} onSeek={handleSeek} />

            {/* Tracks Container */}
            <div className="relative flex flex-col">
              {tracks.map((track) => {
                const trackClips = clips.filter((c) => c.trackId === track.id);

                const handleTrackDrop = (e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove('ring-2', 'ring-blue-500/50');
                  try {
                    const raw = e.dataTransfer.getData('application/x-transcript-segment');
                    if (!raw) return;
                    const data = JSON.parse(raw);
                    if (!data || !data.text) return;
                    const scrollContainer = scrollContainerRef.current;
                    if (!scrollContainer) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const offsetX = e.clientX - rect.left + scrollContainer.scrollLeft;
                    const dropTime = Math.max(0, offsetX / zoomLevel);
                    const dur = Math.max(0.5, data.duration || 2);
                    const newClip = {
                      id: `sub-drop-${Date.now()}`,
                      segmentId: data.id,
                      trackId: track.id,
                      start: Number(dropTime.toFixed(3)),
                      duration: Number(dur.toFixed(2)),
                      type: track.type === 'text' ? 'text' : track.type,
                      content: data.text,
                      color: track.type === 'text' ? '#78350f' : '#27272a',
                    };
                    setClips([...clips, newClip]);
                  } catch (err) {
                    console.warn('Timeline drop failed:', err);
                  }
                };

                const handleTrackDragOver = (e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                  e.currentTarget.classList.add('ring-2', 'ring-blue-500/50');
                };

                const handleTrackDragLeave = (e) => {
                  e.currentTarget.classList.remove('ring-2', 'ring-blue-500/50');
                };

                return (
                  <div
                    key={track.id}
                    className="track-row relative h-14 border-b border-white/5 bg-[#121216]/50 hover:bg-[#14141a]/60 transition-colors"
                    onClick={handleTimelineBackgroundClick}
                    onDrop={handleTrackDrop}
                    onDragOver={handleTrackDragOver}
                    onDragLeave={handleTrackDragLeave}
                  >
                    {/* Subtle lane background grid lines */}
                    <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff03_1px,transparent_1px)] bg-[size:50px_100%] pointer-events-none" />

                    {/* Render clips on this track */}
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
        title="Kéo để chỉnh độ cao timeline"
      >
        <div className={`w-8 h-0.5 rounded-full transition-colors ${
          isResizing ? 'bg-blue-400' : 'bg-zinc-600 group-hover/resizet:bg-zinc-400'
        }`} />
      </div>

      {/* 3. BOTTOM FOOTER & KEYBOARD SHORTCUTS HINTS */}
      <div className="h-8 px-4 bg-[#0a0a0d] border-t border-white/10 flex items-center justify-between text-[11px] text-zinc-400">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.2 bg-zinc-800 border border-zinc-700 rounded text-[10px] font-mono text-zinc-300">
              Space
            </kbd>
            <span>Play / Pause</span>
          </span>

          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.2 bg-zinc-800 border border-zinc-700 rounded text-[10px] font-mono text-zinc-300">
              S
            </kbd>
            <span>Split Clip</span>
          </span>

          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.2 bg-zinc-800 border border-zinc-700 rounded text-[10px] font-mono text-zinc-300">
              Delete
            </kbd>
            <span>Delete Selected</span>
          </span>

          <span className="hidden md:flex items-center gap-1">
            <kbd className="px-1.5 py-0.2 bg-zinc-800 border border-zinc-700 rounded text-[10px] font-mono text-zinc-300">
              ← / →
            </kbd>
            <span>Scrub Playhead</span>
          </span>
        </div>

        <div className="flex items-center gap-2 text-zinc-400">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          <span>CapCut Timeline Engine</span>
        </div>
      </div>
    </div>
  );
}
