import React from 'react';
import { Video, Type, Languages } from 'lucide-react';
import { useTimelineStore } from './timelineStore';

const TRACK_CONFIG = {
  video: { icon: Video, color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  original: { icon: Type, color: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  translated: { icon: Languages, color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
};

export default function TrackSidebar() {
  const { tracks } = useTimelineStore();

  return (
    <div className="w-[72px] flex-shrink-0 bg-[#121216] border-r border-white/10 flex flex-col select-none z-20 shadow-md">
      <div className="h-9 px-2 flex items-center border-b border-white/10 text-[10px] font-medium text-zinc-400 uppercase tracking-wider bg-[#16161b]">
        <span>Layers</span>
      </div>

      <div className="flex flex-col">
        {tracks.map((track) => {
          const config = TRACK_CONFIG[track.type] || TRACK_CONFIG.video;
          const Icon = config.icon;

          return (
            <div
              key={track.id}
              className="h-14 px-2 border-b border-white/5 flex flex-col justify-center gap-1.5 transition-colors duration-150"
              title={track.name}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-[9px] px-1 py-0.2 rounded font-mono font-semibold border ${config.color}`}
                >
                  {track.type === 'video' ? 'V' : track.type === 'original' ? 'O' : 'T'}
                </span>
                <Icon size={12} className="text-zinc-500" />
              </div>
              <div className="text-[8px] text-zinc-500 truncate">{track.name}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
