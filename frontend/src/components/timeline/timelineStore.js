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

  initTimeline: ({ clips, currentTime }) => {
    set((state) => ({
      clips: clips !== undefined ? clips : state.clips,
      currentTime: currentTime !== undefined ? currentTime : state.currentTime,
    }));
  },

  // Clip Modifications
  updateClip: (id, updates) => {
    set((state) => ({
      clips: state.clips.map((clip) =>
        clip.id === id ? { ...clip, ...updates } : clip
      ),
    }));
  },

  deleteClip: (id) => {
    set((state) => ({
      clips: state.clips.filter((clip) => clip.id !== id),
      selectedClipId: state.selectedClipId === id ? null : state.selectedClipId,
    }));
  },
}));
