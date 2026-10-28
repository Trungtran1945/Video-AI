import React from 'react';
import { motion } from 'framer-motion';
import { Clock, Trash2 } from 'lucide-react';
import { useTimelineStore } from './timelineStore';

function fmtSec(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function FloatingToolbar({ clip }) {
  const deleteClip = useTimelineStore((s) => s.deleteClip);
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
        {fmtSec(clip.start)} → {fmtSec(clip.start + clip.duration)}
      </span>
      <span className="text-[10px] text-muted-foreground">
        ({clip.duration.toFixed(1)}s)
      </span>
      <button
        type="button"
        title="Xoá clip khỏi timeline"
        aria-label="Xoá clip khỏi timeline"
        onClick={() => deleteClip(clip.id)}
        className="p-2 min-w-[32px] min-h-[32px] flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive"
      >
        <Trash2 size={11} />
      </button>
    </motion.div>
  );
}
