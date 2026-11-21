import React from 'react';
import { motion } from 'framer-motion';
import { Clock, Scissors, Trash2 } from 'lucide-react';
import { useTimelineStore } from './timelineStore';

function fmtSec(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function FloatingToolbar({ clip }) {
  const deleteClip = useTimelineStore((s) => s.deleteClip);
  const splitClip = useTimelineStore((s) => s.splitClip);
  const currentTime = useTimelineStore((s) => s.currentTime);

  const clipStart = Number(clip.start ?? clip.start_at_sec ?? 0);
  const inSec = Number(clip.in_sec ?? 0);
  const clipDuration = Number(clip.duration ?? (clip.out_sec != null ? clip.out_sec - inSec : 4));

  const canSplitAtPlayhead =
    currentTime > clipStart + 0.15 && currentTime < clipStart + clipDuration - 0.15;

  const handleSplit = () => {
    const splitTime = canSplitAtPlayhead ? currentTime : clipStart + clipDuration / 2;
    splitClip(clip.id, splitTime);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.95 }}
      transition={{ duration: 0.12 }}
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute -top-10 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-popover/95 backdrop-blur-md border border-border text-popover-foreground rounded-md px-2 py-1 shadow-xl z-50 whitespace-nowrap max-w-[calc(100vw-32px)]"
    >
      <Clock size={11} className="text-muted-foreground" />
      <span className="text-[10px] font-mono text-foreground">
        {fmtSec(clipStart)} → {fmtSec(clipStart + clipDuration)}
      </span>
      <span className="text-[10px] text-muted-foreground">
        ({clipDuration.toFixed(1)}s)
      </span>

      <div className="h-3 w-px bg-border mx-0.5" />

      <button
        type="button"
        title={canSplitAtPlayhead ? 'Tách clip tại vị trí con trỏ (S)' : 'Tách đôi clip ở chính giữa'}
        aria-label="Tách clip"
        onClick={handleSplit}
        className="p-1.5 min-w-[28px] min-h-[28px] flex items-center justify-center rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary cursor-pointer"
      >
        <Scissors size={11} />
      </button>

      <button
        type="button"
        title="Xoá clip khỏi timeline (Delete)"
        aria-label="Xoá clip khỏi timeline"
        onClick={() => deleteClip(clip.id)}
        className="p-1.5 min-w-[28px] min-h-[28px] flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive cursor-pointer"
      >
        <Trash2 size={11} />
      </button>
    </motion.div>
  );
}
