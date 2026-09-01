import { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, ZoomIn, ZoomOut } from 'lucide-react';
import { Slider } from '@/components/ui/slider';

const SPEAKER_COLORS = {
  SPEAKER_00: '#3b82f6',
  SPEAKER_01: '#8b5cf6',
  SPEAKER_02: '#ec4899',
  SPEAKER_03: '#f59e0b',
  SPEAKER_04: '#10b981',
  default: '#64748b',
};

function fmtTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const secStr = String(s % 60).padStart(2, '0');
  return `${m}:${secStr}`;
}

function getSpeakerColor(speaker) {
  if (!speaker) return SPEAKER_COLORS.default;
  return SPEAKER_COLORS[speaker] || SPEAKER_COLORS.default;
}

export default function TimelineBar({
  transcript = [],
  currentTime = 0,
  duration = 0,
  isPlaying = false,
  playbackSpeed = 1,
  onSeek,
  onPlayPause,
  onSpeedChange,
  onSegmentClick,
  activeSegmentId,
  volume = 1,
  onVolumeChange,
  muted = false,
  onMuteToggle,
}) {
  const [zoom, setZoom] = useState(1);
  const [hoveredSegment, setHoveredSegment] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const scrubberRef = useRef(null);
  const timelineRef = useRef(null);

  const speeds = [0.5, 1, 1.5, 2];

  const handleScrubberClick = useCallback((e) => {
    if (!scrubberRef.current || !duration) return;
    const rect = scrubberRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek?.(ratio * duration);
  }, [duration, onSeek]);

  const handleScrubberDrag = useCallback((e) => {
    if (e.buttons !== 1) return;
    handleScrubberClick(e);
  }, [handleScrubberClick]);

  const handleSegmentHover = useCallback((segment, e) => {
    setHoveredSegment(segment);
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }, []);

  const progressRatio = duration > 0 ? (currentTime / duration) * 100 : 0;

  const visibleSegments = transcript.map((seg, i) => {
    const startRatio = duration > 0 ? (seg.startSec / duration) * 100 : 0;
    const widthRatio = duration > 0 ? ((seg.endSec - seg.startSec) / duration) * 100 : 0;
    return { ...seg, index: i, startRatio, widthRatio };
  });

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          onPlayPause?.();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          onSeek?.(Math.max(0, currentTime - 5));
          break;
        case 'ArrowRight':
          e.preventDefault();
          onSeek?.(Math.min(duration, currentTime + 5));
          break;
        case 'ArrowUp': {
          e.preventDefault();
          const currentIdx = transcript.findIndex(s => s.id === activeSegmentId);
          if (currentIdx > 0) {
            onSegmentClick?.(transcript[currentIdx - 1].id);
          }
          break;
        }
        case 'ArrowDown': {
          e.preventDefault();
          const currentIdx = transcript.findIndex(s => s.id === activeSegmentId);
          if (currentIdx < transcript.length - 1) {
            onSegmentClick?.(transcript[currentIdx + 1].id);
          }
          break;
        }
        case '+':
        case '=':
          e.preventDefault();
          setZoom(z => Math.min(4, z + 0.5));
          break;
        case '-':
          e.preventDefault();
          setZoom(z => Math.max(0.5, z - 0.5));
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentTime, duration, transcript, activeSegmentId, onSeek, onPlayPause, onSegmentClick]);

  return (
    <div className="bg-[#161922] border-t border-white/5 px-4 py-2">
      <div className="flex items-center gap-3">
        {/* Playback Controls */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => onSeek?.(Math.max(0, currentTime - 5))}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition"
            title="Lùi 5s (←)"
          >
            <SkipBack className="w-4 h-4" />
          </button>

          <button
            onClick={onPlayPause}
            className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition"
            title="Play/Pause (Space)"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>

          <button
            onClick={() => onSeek?.(Math.min(duration, currentTime + 5))}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition"
            title="Tiến 5s (→)"
          >
            <SkipForward className="w-4 h-4" />
          </button>
        </div>

        {/* Time Display */}
        <div className="text-xs text-slate-400 tabular-nums shrink-0 w-24">
          {fmtTime(currentTime)} / {fmtTime(duration)}
        </div>

        {/* Scrubber Bar */}
        <div className="flex-1 min-w-0">
          <div
            ref={scrubberRef}
            className="relative h-6 cursor-pointer group"
            onClick={handleScrubberClick}
            onMouseMove={handleScrubberDrag}
          >
            {/* Track background */}
            <div className="absolute inset-y-2 left-0 right-0 rounded-full bg-white/10" />

            {/* Progress */}
            <div
              className="absolute inset-y-2 left-0 rounded-full bg-blue-500"
              style={{ width: `${progressRatio}%` }}
            />

            {/* Segment markers */}
            {visibleSegments.map((seg) => (
              <div
                key={seg.id}
                className={`absolute inset-y-1 cursor-pointer transition-all duration-150 rounded-sm ${
                  seg.id === activeSegmentId
                    ? 'ring-2 ring-blue-400 z-10'
                    : 'hover:brightness-125'
                }`}
                style={{
                  left: `${seg.startRatio}%`,
                  width: `${Math.max(seg.widthRatio, 0.5)}%`,
                  backgroundColor: getSpeakerColor(seg.speaker),
                  opacity: seg.id === activeSegmentId ? 1 : 0.7,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSegmentClick?.(seg.id);
                  onSeek?.(seg.startSec);
                }}
                onMouseEnter={(e) => handleSegmentHover(seg, e)}
                onMouseLeave={() => setHoveredSegment(null)}
              />
            ))}

            {/* Playhead */}
            <div
              className="absolute inset-y-0 w-0.5 bg-white shadow-lg"
              style={{ left: `${progressRatio}%` }}
            >
              <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-white" />
            </div>
          </div>
        </div>

        {/* Zoom Controls */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setZoom(z => Math.max(0.5, z - 0.5))}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/5 transition"
            title="Thu nhỏ (-)"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="text-[10px] text-slate-500 w-8 text-center">{zoom}x</span>
          <button
            onClick={() => setZoom(z => Math.min(4, z + 0.5))}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/5 transition"
            title="Phóng to (+)"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Speed Selector */}
        <div className="flex items-center gap-1 shrink-0">
          {speeds.map(speed => (
            <button
              key={speed}
              onClick={() => onSpeedChange?.(speed)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
                playbackSpeed === speed
                  ? 'bg-blue-500/20 text-blue-400'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {speed}x
            </button>
          ))}
        </div>

        {/* Volume */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onMuteToggle}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/5 transition"
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
          <Slider
            value={[muted ? 0 : volume]}
            min={0}
            max={1}
            step={0.1}
            onValueChange={(v) => onVolumeChange?.(v[0])}
            className="w-16"
          />
        </div>
      </div>

      {/* Segment Text Track */}
      <div
        ref={timelineRef}
        className="relative h-8 mt-1 overflow-hidden"
        style={{ transform: `scaleX(${zoom})`, transformOrigin: 'left center' }}
      >
        {visibleSegments.map((seg) => (
          <div
            key={seg.id}
            className={`absolute inset-y-0 flex items-center px-1 text-[9px] truncate cursor-pointer transition-all duration-150 ${
              seg.id === activeSegmentId
                ? 'bg-blue-500/20 text-blue-300 font-medium'
                : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
            }`}
            style={{
              left: `${seg.startRatio}%`,
              width: `${Math.max(seg.widthRatio, 0.5)}%`,
              borderLeft: `2px solid ${getSpeakerColor(seg.speaker)}`,
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSegmentClick?.(seg.id);
              onSeek?.(seg.startSec);
            }}
            title={seg.text || seg.translation || ''}
          >
            <span className="truncate">{seg.text || seg.translation || `#${seg.index + 1}`}</span>
          </div>
        ))}
      </div>

      {/* Tooltip */}
      {hoveredSegment && (
        <div
          className="fixed z-50 px-2 py-1 rounded bg-[#0F1117] border border-white/10 text-xs text-slate-200 max-w-xs pointer-events-none"
          style={{ left: tooltipPos.x + 10, top: tooltipPos.y - 40 }}
        >
          <div className="font-medium">{fmtTime(hoveredSegment.startSec)} → {fmtTime(hoveredSegment.endSec)}</div>
          <div className="text-slate-400 truncate">{hoveredSegment.text || hoveredSegment.translation || ''}</div>
          {hoveredSegment.translation && hoveredSegment.text && (
            <div className="text-slate-500 truncate mt-0.5">→ {hoveredSegment.translation}</div>
          )}
        </div>
      )}
    </div>
  );
}
