import React from 'react';
import { Video, Type, Languages, Layers, Image as ImageIcon, Mic, Music, Volume2, VolumeX } from 'lucide-react';
import { useTimelineStore } from './timelineStore';

const TRACK_CONFIG = {
  video: { icon: Video, tag: 'V', color: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30' },
  original: { icon: Type, tag: 'O', color: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30' },
  translated: { icon: Languages, tag: 'T', color: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' },
  background: { icon: Layers, tag: 'BG', color: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30' },
  image: { icon: ImageIcon, tag: 'IMG', color: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30' },
  voiceover: { icon: Mic, tag: 'VOX', color: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30' },
  music: { icon: Music, tag: 'BGM', color: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30' },
  text: { icon: Type, tag: 'TXT', color: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' },
};

export default function TrackSidebar() {
  const { tracks, toggleTrackMute } = useTimelineStore();

  return (
    <div className="w-14 sm:w-20 flex-shrink-0 bg-card border-r border-border flex flex-col select-none z-20 shadow-xs">
      <div className="h-9 px-2 flex items-center justify-between border-b border-border text-[10px] font-medium text-muted-foreground uppercase tracking-wider bg-muted/50">
        <span>Layers</span>
      </div>

      <div className="flex flex-col">
        {tracks.map((track) => {
          const typeKey = track.track_type || track.type;
          const config = TRACK_CONFIG[typeKey] || TRACK_CONFIG.video;
          const Icon = config.icon;
          const isMuted = track.muted === 1 || track.isMuted;
          const isAudioTrack = ['voiceover', 'music', 'video'].includes(typeKey);

          return (
            <div
              key={track.id}
              className="h-14 px-2 border-b border-border/50 flex flex-col justify-center gap-1 transition-colors duration-150"
              title={track.name}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-[9px] px-1 py-0.2 rounded font-mono font-semibold border ${config.color}`}
                >
                  {config.tag || 'L'}
                </span>
                <div className="flex items-center gap-1">
                  {isAudioTrack && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleTrackMute(track.id);
                      }}
                      title={isMuted ? 'Bật tiếng' : 'Tắt tiếng rãnh'}
                      className="text-muted-foreground hover:text-foreground transition p-0.5"
                    >
                      {isMuted ? <VolumeX size={11} className="text-destructive" /> : <Volume2 size={11} />}
                    </button>
                  )}
                  <Icon size={12} className="text-muted-foreground" />
                </div>
              </div>
              <div className="text-[8px] text-muted-foreground truncate hidden sm:block font-medium">
                {track.name}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
