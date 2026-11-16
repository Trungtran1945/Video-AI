import { create } from 'zustand';

// Subtitle sync timeline tracks: Video (reference), Original, Translated
const INITIAL_TRACKS = [
  {
    id: 'track-video-1',
    type: 'video',
    name: 'Video',
    isLocked: true,
    isMuted: false,
  },
  {
    id: 'track-original-1',
    type: 'original',
    name: 'Gốc (Original)',
    isLocked: true,
    isMuted: false,
  },
  {
    id: 'track-translated-1',
    type: 'translated',
    name: 'Dịch (Translated)',
    isLocked: false,
    isMuted: false,
  },
];

const INITIAL_CLIPS = [];

// Sample content for the /timeline demo route (no NaN/empty white-screen).
export const MOCK_DEMO_CLIPS = [
  { id: 'demo-clip-1', trackId: 'track-video-1', type: 'video', content: 'Mở đầu', start: 0, duration: 12, speed: 1, volume: 100 },
  { id: 'demo-clip-2', trackId: 'track-video-1', type: 'video', content: 'Cao trào', start: 12, duration: 18, speed: 1, volume: 100 },
  { id: 'demo-clip-3', trackId: 'track-original-1', type: 'original', content: 'Lời thoại gốc', start: 2, duration: 10, speed: 1, volume: 100 },
  { id: 'demo-clip-4', trackId: 'track-translated-1', type: 'translated', content: 'Lời thoại dịch', start: 2, duration: 10, speed: 1, volume: 100 },
];

export const useTimelineStore = create((set, get) => ({
  // Core State
  currentTime: 0,
  // R2: viewport nhỏ khởi tạo zoom thấp để timeline vừa màn hình (clamp 15–200 giữ nguyên).
  zoomLevel: (typeof window !== 'undefined' && window.innerWidth < 640) ? 20 : 50,
  tracks: INITIAL_TRACKS,
  clips: INITIAL_CLIPS,
  selectedClipId: null,

  // Playback & Snapping
  isPlaying: false,
  snappingGuide: null,
  snappingEnabled: true,

  // State Setters
  setCurrentTime: (time) => set({ currentTime: Math.max(0, Number(time.toFixed(3))) }),
  setZoomLevel: (zoom) => set({ zoomLevel: Math.max(15, Math.min(200, zoom)) }),
  setSelectedClipId: (id) => set({ selectedClipId: id }),
  setSnappingGuide: (time) => set({ snappingGuide: time }),
  toggleSnapping: () => set((state) => ({ snappingEnabled: !state.snappingEnabled })),

  togglePlayPause: () => set((state) => ({ isPlaying: !state.isPlaying })),
  setIsPlaying: (isPlaying) => set({ isPlaying }),

  setClips: (clips) => set({ clips: Array.isArray(clips) ? clips : [] }),

  setTracks: (tracks) => set({ tracks: Array.isArray(tracks) ? tracks : [] }),
  addTrack: (track) => set((state) => ({ tracks: [...state.tracks, track] })),
  updateTrack: (id, updates) =>
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),
  toggleTrackMute: (id) =>
    set((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === id ? { ...t, isMuted: !t.isMuted, muted: !t.muted } : t
      ),
    })),
  setTrackVolume: (id, volume) =>
    set((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === id ? { ...t, volume: Math.max(0, Math.min(1, volume)) } : t
      ),
    })),
  addClip: (clip) => set((state) => {
    const c = { ...clip };
    if (c.start !== undefined && c.start_at_sec === undefined) c.start_at_sec = c.start;
    if (c.start_at_sec !== undefined && c.start === undefined) c.start = c.start_at_sec;
    if (c.duration !== undefined && c.out_sec === undefined) {
      c.out_sec = Number(((Number(c.in_sec) || 0) + c.duration).toFixed(3));
    }
    return { clips: [...state.clips, c] };
  }),
  clearClips: () => set({ clips: [], selectedClipId: null }),

  initTimeline: ({ clips, currentTime, tracks }) => {
    set((state) => ({
      tracks: tracks !== undefined ? tracks : state.tracks,
      clips: clips !== undefined ? clips : state.clips,
      currentTime: currentTime !== undefined ? currentTime : state.currentTime,
    }));
  },

  // Clip Modifications
  updateClip: (id, updates) => {
    set((state) => ({
      clips: state.clips.map((clip) => {
        if (clip.id !== id) return clip;
        const merged = { ...clip, ...updates };
        if (updates.start !== undefined) {
          merged.start_at_sec = updates.start;
        } else if (updates.start_at_sec !== undefined) {
          merged.start = updates.start_at_sec;
        }
        if (updates.duration !== undefined) {
          const inSec = Number(merged.in_sec ?? 0);
          merged.out_sec = Number((inSec + updates.duration).toFixed(3));
        } else if (updates.out_sec !== undefined) {
          const inSec = Number(merged.in_sec ?? 0);
          merged.duration = Math.max(0.1, Number((updates.out_sec - inSec).toFixed(3)));
        }
        return merged;
      }),
    }));
  },

  deleteClip: (id) => {
    set((state) => ({
      clips: state.clips.filter((clip) => clip.id !== id),
      selectedClipId: state.selectedClipId === id ? null : state.selectedClipId,
    }));
  },
}));
