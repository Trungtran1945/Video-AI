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

export const MOCK_DEMO_CLIPS = [];

export const useTimelineStore = create((set, get) => ({
  // Core State
  currentTime: 0,
  zoomLevel: 50,
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
  setSnappingEnabled: (enabled) => set({ snappingEnabled: enabled }),
  toggleSnapping: () => set((state) => ({ snappingEnabled: !state.snappingEnabled })),

  togglePlayPause: () => set((state) => ({ isPlaying: !state.isPlaying })),
  setIsPlaying: (isPlaying) => set({ isPlaying }),

  setClips: (clips) => set({ clips: Array.isArray(clips) ? clips : [] }),
  setTracks: (tracks) => set({ tracks: Array.isArray(tracks) ? tracks : [] }),

  initTimeline: ({ tracks, clips, currentTime }) => {
    set((state) => ({
      tracks: tracks || state.tracks,
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
