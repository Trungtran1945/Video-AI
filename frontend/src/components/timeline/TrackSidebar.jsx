import React from 'react';
import { Lock, Unlock, Volume2, VolumeX, Trash2, Video, Music, Type, Layers } from 'lucide-react';
import { useTimelineStore } from './timelineStore';

const TRACK_ICONS = {
  video: Video,
  audio: Music,
  text: Type,
  overlay: Layers,
};

const TRACK_BADGE_COLORS = {
  video: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  audio: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  text: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  overlay: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
};

export default function TrackSidebar() {
  const { tracks, toggleTrackLock, toggleTrackMute, deleteTrack } = useTimelineStore();

  return (
    <div className="w-[72px] flex-shrink-0 bg-[#121216] border-r border-white/10 flex flex-col select-none z-20 shadow-md">
      {/* Top Header matching the Time Ruler sticky height (36px) */}
      <div className="h-9 px-2 flex items-center justify-between border-b border-white/10 text-[10px] font-medium text-zinc-400 uppercase tracking-wider bg-[#16161b]">
        <span>Tracks</span>
        <span className="text-[9px] text-zinc-500">{tracks.length}</span>
      </div>

      {/* Track Control Rows */}
      <div className="flex flex-col">
        {tracks.map((track, idx) => {
          const Icon = TRACK_ICONS[track.type] || Video;
          const badgeClass = TRACK_BADGE_COLORS[track.type] || 'bg-zinc-700 text-zinc-300';
          const shortName = `${track.type.slice(0, 1).toUpperCase()}${idx + 1}`;

          return (
            <div
              key={track.id}
              className="h-14 px-2 border-b border-white/5 flex flex-col justify-center gap-1.5 transition-colors duration-150 hover:bg-white/[0.03]"
              title={`${track.name} (${track.type})`}
            >
              {/* Row Header: Badge and Type Icon */}
              <div className="flex items-center justify-between">
                <span
                  className={`text-[9px] px-1 py-0.2 rounded font-mono font-semibold border ${badgeClass}`}
                >
                  {shortName}
                </span>
                <Icon size={12} className="text-zinc-500" />
              </div>

              {/* Row Action Controls: Lock, Mute, Delete */}
              <div className="flex items-center justify-between text-zinc-400">
                {/* Lock Toggle */}
                <button
                  type="button"
                  onClick={() => toggleTrackLock(track.id)}
                  title={track.isLocked ? 'Unlock track' : 'Lock track'}
                  className={`p-1 rounded hover:bg-white/10 transition-colors ${
                    track.isLocked ? 'text-amber-400 bg-amber-500/10' : 'hover:text-zinc-200'
                  }`}
                >
                  {track.isLocked ? <Lock size={12} /> : <Unlock size={12} />}
                </button>

                {/* Mute Toggle */}
                <button
                  type="button"
                  onClick={() => toggleTrackMute(track.id)}
                  title={track.isMuted ? 'Unmute track' : 'Mute track'}
                  className={`p-1 rounded hover:bg-white/10 transition-colors ${
                    track.isMuted ? 'text-red-400 bg-red-500/10' : 'hover:text-zinc-200'
                  }`}
                >
                  {track.isMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                </button>

                {/* Delete Track */}
                <button
                  type="button"
                  onClick={() => deleteTrack(track.id)}
                  title="Delete track"
                  className="p-1 rounded hover:bg-red-500/20 hover:text-red-300 transition-colors"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
