import React, { useEffect } from 'react';
import { VideoTimeline, useTimelineStore, formatTimeCode, MOCK_DEMO_CLIPS } from '@/components/timeline';
import { Film, Sliders } from 'lucide-react';

export default function TimelineDemo() {
  const {
    currentTime,
    clips,
    setClips,
    selectedClipId,
    updateClip,
    tracks,
  } = useTimelineStore();

  useEffect(() => {
    if (clips.length === 0) {
      setClips(MOCK_DEMO_CLIPS);
    }
  }, [clips.length, setClips]);

  const selectedClip = clips.find((c) => c.id === selectedClipId);

  // Find clip under playhead on video track (if any)
  const activeVideoClip = clips.find(
    (c) =>
      c.type === 'video' &&
      currentTime >= c.start &&
      currentTime <= c.start + c.duration
  );

  return (
    <div className="min-h-screen bg-[#0a0a0d] text-zinc-100 flex flex-col justify-between">
      {/* Top Navbar */}
      <header className="h-14 px-6 bg-[#121216] border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-red-600 to-amber-500 flex items-center justify-center shadow-lg shadow-red-500/20">
            <Film size={18} className="text-white" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white flex items-center gap-2">
              <span>CapCut Timeline Studio</span>
              <span className="text-[10px] font-mono font-normal bg-red-500/20 text-red-400 border border-red-500/30 px-1.5 py-0.2 rounded">
                PRO
              </span>
            </h1>
            <p className="text-[11px] text-zinc-400">
              Interactive Multi-track Video Editing Timeline
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-[#181820] border border-white/10 px-3 py-1 rounded-lg text-xs">
            <span className="text-zinc-400">Active Tracks:</span>
            <span className="font-mono font-semibold text-white">{tracks.length}</span>
            <span className="text-zinc-600">•</span>
            <span className="text-zinc-400">Clips:</span>
            <span className="font-mono font-semibold text-white">{clips.length}</span>
          </div>
        </div>
      </header>

      {/* Main Studio Work Area */}
      <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto flex flex-col gap-5">
        {/* Top Preview Canvas & Inspector Panel */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Video Preview Canvas */}
          <div className="lg:col-span-2 bg-[#121217] border border-white/10 rounded-xl p-4 flex flex-col items-center justify-center min-h-[260px] relative overflow-hidden shadow-xl">
            {/* Monitor Header */}
            <div className="absolute top-3 left-4 right-4 flex items-center justify-between z-10">
              <span className="text-[11px] font-mono text-zinc-400 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                1080p • 30 FPS • Rec.709
              </span>
              <span className="text-[11px] font-mono text-zinc-300 bg-black/60 px-2 py-0.5 rounded border border-white/10">
                {formatTimeCode(currentTime)}
              </span>
            </div>

            {/* Active Content Simulation */}
            <div className="w-full max-w-lg aspect-video bg-[#09090c] border border-white/10 rounded-lg flex flex-col items-center justify-center relative shadow-2xl p-6 text-center">
              {activeVideoClip ? (
                <div className="flex flex-col items-center gap-2 animate-in fade-in duration-200">
                  <div className="w-12 h-12 rounded-full bg-blue-500/20 border border-blue-500/40 flex items-center justify-center text-blue-400 shadow-lg">
                    <Film size={22} />
                  </div>
                  <h3 className="font-semibold text-sm text-white">
                    {activeVideoClip.content}
                  </h3>
                  <p className="text-xs text-zinc-400 font-mono">
                    Elapsed in clip: {(currentTime - activeVideoClip.start).toFixed(2)}s / {activeVideoClip.duration.toFixed(2)}s
                  </p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 text-zinc-600">
                  <Film size={28} className="opacity-40" />
                  <span className="text-xs">No video frame at {currentTime.toFixed(2)}s</span>
                  <span className="text-[11px] text-zinc-500">
                    Scrub the red playhead over a clip below
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Selected Clip Inspector Panel */}
          <div className="bg-[#121217] border border-white/10 rounded-xl p-4 flex flex-col justify-between shadow-xl">
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-white/10 mb-4">
                <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                  <Sliders size={13} className="text-blue-400" />
                  <span>Clip Inspector</span>
                </h2>
                {selectedClip && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 uppercase">
                    {selectedClip.type}
                  </span>
                )}
              </div>

              {selectedClip ? (
                <div className="flex flex-col gap-3 text-xs">
                  <div>
                    <label className="text-[11px] text-zinc-400 block mb-1">Content Label</label>
                    <input
                      type="text"
                      value={selectedClip.content}
                      onChange={(e) => updateClip(selectedClip.id, { content: e.target.value })}
                      className="w-full bg-[#181820] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] text-zinc-400 block mb-1">Start (sec)</label>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={selectedClip.start}
                        onChange={(e) => updateClip(selectedClip.id, { start: Math.max(0, parseFloat(e.target.value) || 0) })}
                        className="w-full bg-[#181820] border border-white/10 rounded-lg px-2 py-1 text-xs font-mono text-white focus:outline-none focus:border-blue-500"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-zinc-400 block mb-1">Duration (sec)</label>
                      <input
                        type="number"
                        step="0.1"
                        min="0.2"
                        value={selectedClip.duration}
                        onChange={(e) => updateClip(selectedClip.id, { duration: Math.max(0.2, parseFloat(e.target.value) || 0.5) })}
                        className="w-full bg-[#181820] border border-white/10 rounded-lg px-2 py-1 text-xs font-mono text-white focus:outline-none focus:border-blue-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 mt-1">
                    <div>
                      <label className="text-[11px] text-zinc-400 block mb-1">Speed</label>
                      <div className="bg-[#181820] border border-white/10 rounded-lg px-2 py-1.5 text-xs font-mono text-zinc-300 flex justify-between items-center">
                        <span>{selectedClip.speed || 1}x</span>
                        <span className="text-[10px] text-zinc-500">Toolbar</span>
                      </div>
                    </div>
                    <div>
                      <label className="text-[11px] text-zinc-400 block mb-1">Volume</label>
                      <div className="bg-[#181820] border border-white/10 rounded-lg px-2 py-1.5 text-xs font-mono text-zinc-300 flex justify-between items-center">
                        <span>{selectedClip.volume ?? 100}%</span>
                        <span className="text-[10px] text-zinc-500">Toolbar</span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="h-40 flex flex-col items-center justify-center text-zinc-500 text-center text-xs">
                  <p>Click any clip in the timeline to select and edit its properties.</p>
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-white/10 text-[11px] text-zinc-500">
              Magnetic snapping and trimming automatically update in real-time.
            </div>
          </div>
        </div>

        {/* The CapCut Video Editing Timeline Component */}
        <div className="w-full shadow-2xl">
          <VideoTimeline />
        </div>
      </main>
    </div>
  );
}
