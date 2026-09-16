import React from 'react';
import { Video, Type, Languages } from 'lucide-react';
import { useTimelineStore } from './timelineStore';

const TRACK_CONFIG = {
  video: { icon: Video, color: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30' },
  original: { icon: Type, color: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30' },
  translated: { icon: Languages, color: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' },
};

export default function TrackSidebar() {
  const { tracks } = useTimelineStore();

  return (
    <div className="w-[72px] flex-shrink-0 bg-card border-r border-border flex flex-col select-none z-20 shadow-xs">
      <div className="h-9 px-2 flex items-center border-b border-border text-[10px] font-medium text-muted-foreground uppercase tracking-wider bg-muted/50">
        <span>Layers</span>
      </div>

      <div className="flex flex-col">
        {tracks.map((track) => {
          const config = TRACK_CONFIG[track.type] || TRACK_CONFIG.video;
          const Icon = config.icon;

          return (
            <div
              key={track.id}
              className="h-14 px-2 border-b border-border/50 flex flex-col justify-center gap-1.5 transition-colors duration-150"
              title={track.name}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-[9px] px-1 py-0.2 rounded font-mono font-semibold border ${config.color}`}
                >
                  {track.type === 'video' ? 'V' : track.type === 'original' ? 'O' : 'T'}
                </span>
                <Icon size={12} className="text-muted-foreground" />
              </div>
              <div className="text-[8px] text-muted-foreground truncate">{track.name}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
