import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Scissors, Trash2, Gauge, Volume2, VolumeX, AlertCircle } from 'lucide-react';
import { useTimelineStore } from './timelineStore';

export default function FloatingToolbar({ clip }) {
  const { currentTime, splitClip, deleteClip, updateClip } = useTimelineStore();
  const [showWarning, setShowWarning] = useState(false);

  const canSplit =
    currentTime > clip.start + 0.05 && currentTime < clip.start + clip.duration - 0.05;

  const handleSplit = (e) => {
    e.stopPropagation();
    e.preventDefault();

    if (!canSplit) {
      setShowWarning(true);
      setTimeout(() => setShowWarning(false), 2200);
      return;
    }

    splitClip(clip.id);
  };

  const handleDelete = (e) => {
    e.stopPropagation();
    e.preventDefault();
    deleteClip(clip.id);
  };

  const handleSpeedCycle = (e) => {
    e.stopPropagation();
    e.preventDefault();
    const speeds = [0.5, 1, 1.25, 1.5, 2];
    const currentSpeed = clip.speed || 1;
    const nextIdx = (speeds.indexOf(currentSpeed) + 1) % speeds.length;
    updateClip(clip.id, { speed: speeds[nextIdx] });
  };

  const handleVolumeToggle = (e) => {
    e.stopPropagation();
    e.preventDefault();
    const currentVol = clip.volume !== undefined ? clip.volume : 100;
    updateClip(clip.id, { volume: currentVol === 0 ? 100 : 0 });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.95 }}
      transition={{ duration: 0.12 }}
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute -top-10 left-1/2 -translate-x-1/2 flex items-center gap-0.5 bg-[#18181f]/95 backdrop-blur-md border border-white/20 rounded-md p-1 shadow-2xl z-50 whitespace-nowrap"
    >
      {/* Warning if playhead not in clip when trying to split */}
      {showWarning && (
        <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-amber-500/90 text-black font-medium text-[10px] px-2 py-0.5 rounded shadow flex items-center gap-1">
          <AlertCircle size={11} />
          <span>Move playhead over clip to split</span>
        </div>
      )}

      {/* Split Button */}
      <button
        type="button"
        onClick={handleSplit}
        title={canSplit ? 'Split clip at playhead (S)' : 'Move playhead inside clip to split'}
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors ${
          canSplit
            ? 'text-white hover:bg-white/20 hover:text-white'
            : 'text-zinc-500 hover:bg-zinc-800'
        }`}
      >
        <Scissors size={12} className={canSplit ? 'text-cyan-400' : ''} />
        <span>Split</span>
      </button>

      <div className="w-[1px] h-3 bg-white/10 mx-0.5" />

      {/* Speed Control Button */}
      <button
        type="button"
        onClick={handleSpeedCycle}
        title="Cycle playback speed (0.5x, 1x, 1.25x, 1.5x, 2x)"
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-zinc-200 hover:text-white hover:bg-white/15 transition-colors"
      >
        <Gauge size={12} className="text-amber-400" />
        <span className="font-mono text-[10px]">{clip.speed || 1}x</span>
      </button>

      <div className="w-[1px] h-3 bg-white/10 mx-0.5" />

      {/* Volume Button */}
      <button
        type="button"
        onClick={handleVolumeToggle}
        title={clip.volume === 0 ? 'Unmute clip' : 'Mute clip'}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-zinc-200 hover:text-white hover:bg-white/15 transition-colors"
      >
        {clip.volume === 0 ? (
          <VolumeX size={12} className="text-red-400" />
        ) : (
          <Volume2 size={12} className="text-emerald-400" />
        )}
        <span className="font-mono text-[10px]">{clip.volume ?? 100}%</span>
      </button>

      <div className="w-[1px] h-3 bg-white/10 mx-0.5" />

      {/* Delete Button */}
      <button
        type="button"
        onClick={handleDelete}
        title="Delete clip (Delete)"
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-red-400 hover:bg-red-500/20 hover:text-red-300 transition-colors"
      >
        <Trash2 size={12} />
        <span>Delete</span>
      </button>
    </motion.div>
  );
}
