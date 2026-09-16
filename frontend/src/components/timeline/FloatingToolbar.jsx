import React from 'react';
import { motion } from 'framer-motion';
import { Clock } from 'lucide-react';

function fmtSec(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function FloatingToolbar({ clip }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.95 }}
      transition={{ duration: 0.12 }}
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute -top-10 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-popover/95 backdrop-blur-md border border-border text-popover-foreground rounded-md px-2 py-1 shadow-xl z-50 whitespace-nowrap"
    >
      <Clock size={11} className="text-muted-foreground" />
      <span className="text-[10px] font-mono text-foreground">
        {fmtSec(clip.start)} → {fmtSec(clip.start + clip.duration)}
      </span>
      <span className="text-[10px] text-muted-foreground">
        ({clip.duration.toFixed(1)}s)
      </span>
    </motion.div>
  );
}
