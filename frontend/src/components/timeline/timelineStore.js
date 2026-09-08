import { create } from 'zustand';

// Clean initial tracks (No mock clips by default)
const INITIAL_TRACKS = [
  {
    id: 'track-video-1',
    type: 'video',
    name: 'Video',
    isLocked: false,
    isMuted: false,
  },
  {
    id: 'track-audio-1',
    type: 'audio',
    name: 'Lồng tiếng (Audio)',
    isLocked: false,
    isMuted: false,
  },
  {
    id: 'track-text-1',
    type: 'text',
    name: 'Phụ đề (Subtitles)',
    isLocked: false,
    isMuted: false,
  },
];

// Default empty clips array - ZERO mock data
const INITIAL_CLIPS = [];

// Mock clips exported strictly for /timeline demo page testing
export const MOCK_DEMO_CLIPS = [
  {
    id: 'clip-v1',
    trackId: 'track-video-1',
    start: 0,
    duration: 4.5,
    type: 'video',
    content: 'Intro_Cinematic_4k.mp4',
    color: '#27272a',
    speed: 1,
    volume: 100,
  },
  {
    id: 'clip-v2',
    trackId: 'track-video-1',
    start: 6.0,
    duration: 5.5,
    type: 'video',
    content: 'Aerial_Drone_Coast.mp4',
    color: '#27272a',
    speed: 1,
    volume: 100,
  },
  {
    id: 'clip-v3',
    trackId: 'track-video-1',
    start: 13.0,
    duration: 5.0,
    type: 'video',
    content: 'Urban_Night_Lights.mp4',
    color: '#27272a',
    speed: 1,
    volume: 100,
  },
  {
    id: 'clip-a1',
    trackId: 'track-audio-1',
    start: 0.5,
    duration: 7.5,
    type: 'audio',
    content: 'Synthwave_Atmosphere.wav',
    color: '#064e3b',
    speed: 1,
    volume: 80,
  },
  {
    id: 'clip-a2',
    trackId: 'track-audio-1',
    start: 9.0,
    duration: 8.5,
    type: 'audio',
    content: 'Voiceover_Interview_Master.wav',
    color: '#064e3b',
    speed: 1,
    volume: 100,
  },
  {
    id: 'clip-t1',
    trackId: 'track-text-1',
    start: 2.0,
    duration: 4.0,
    type: 'text',
    content: 'NEO TOKYO 2026',
    color: '#78350f',
    speed: 1,
    volume: 100,
  },
];

export const useTimelineStore = create((set, get) => ({
  // Core State
  currentTime: 0,   // in seconds
  zoomLevel: 50,    // pixels per second (default 50)
  tracks: INITIAL_TRACKS,
  clips: INITIAL_CLIPS,
  selectedClipId: null,

  // Interactive Playback & Snapping
  isPlaying: false,
  snappingGuide: null, // time in seconds or null
  snappingEnabled: true,
  autoSnapEdges: true, // when true, adjacent clips on same track stick together (no gaps)

  // Helper selector to get tracks with their associated clips
  getTracksWithClips: () => {
    const { tracks, clips } = get();
    return tracks.map((track) => ({
      ...track,
      clips: clips.filter((clip) => clip.trackId === track.id),
    }));
  },

  // State Setters
  setCurrentTime: (time) => set({ currentTime: Math.max(0, Number(time.toFixed(3))) }),
  setZoomLevel: (zoom) => set({ zoomLevel: Math.max(15, Math.min(200, zoom)) }),
  setSelectedClipId: (id) => set({ selectedClipId: id }),
  setSnappingGuide: (time) => set({ snappingGuide: time }),
  setSnappingEnabled: (enabled) => set({ snappingEnabled: enabled }),
  toggleSnapping: () => set((state) => ({ snappingEnabled: !state.snappingEnabled })),
  toggleAutoSnapEdges: () => set((state) => ({ autoSnapEdges: !state.autoSnapEdges })),

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

  // Splitting: Divides the selected clip into two clips at currentTime
  splitClip: (clipId, customSplitTime = null) => {
    const { clips, currentTime } = get();
    const targetClip = clips.find((c) => c.id === clipId);
    if (!targetClip) return false;

    const splitAt = customSplitTime !== null ? customSplitTime : currentTime;
    const clipStart = targetClip.start;
    const clipEnd = targetClip.start + targetClip.duration;

    // Check that splitAt falls strictly inside the clip bounds (with at least 0.1s margin)
    if (splitAt <= clipStart + 0.1 || splitAt >= clipEnd - 0.1) {
      return false; // Cannot split outside or too close to edge
    }

    const firstDuration = Number((splitAt - clipStart).toFixed(3));
    const secondDuration = Number((clipEnd - splitAt).toFixed(3));

    const leftClip = {
      ...targetClip,
      duration: firstDuration,
    };

    const rightClip = {
      ...targetClip,
      id: `${targetClip.id}_split_${Date.now()}`,
      start: splitAt,
      duration: secondDuration,
      content: targetClip.content.includes('(Part')
        ? targetClip.content
        : `${targetClip.content} (Part 2)`,
    };

    set((state) => ({
      clips: state.clips
        .map((c) => (c.id === targetClip.id ? leftClip : c))
        .concat(rightClip),
      selectedClipId: rightClip.id,
    }));

    return true;
  },

  // Track Controls
  toggleTrackLock: (trackId) => {
    set((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === trackId ? { ...t, isLocked: !t.isLocked } : t
      ),
    }));
  },

  toggleTrackMute: (trackId) => {
    set((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === trackId ? { ...t, isMuted: !t.isMuted } : t
      ),
    }));
  },

  deleteTrack: (trackId) => {
    set((state) => ({
      tracks: state.tracks.filter((t) => t.id !== trackId),
      clips: state.clips.filter((c) => c.trackId !== trackId),
      selectedClipId: state.clips.some((c) => c.trackId === trackId && c.id === state.selectedClipId)
        ? null
        : state.selectedClipId,
    }));
  },

  addTrack: (type = 'video') => {
    const id = `track-${type}-${Date.now()}`;
    const nameMap = { video: 'Video', audio: 'Lồng tiếng', text: 'Phụ đề', overlay: 'Overlay' };
    const count = get().tracks.filter((t) => t.type === type).length + 1;
    const newTrack = {
      id,
      type,
      name: `${nameMap[type] || 'Track'} ${count}`,
      isLocked: false,
      isMuted: false,
    };

    set((state) => ({
      tracks: [...state.tracks, newTrack],
    }));
  },

  // Snap edges: close gaps between adjacent clips on the same track
  snapEdgesForTrack: (trackId) => {
    const { clips, autoSnapEdges } = get();
    if (!autoSnapEdges) return;
    const GAP_THRESHOLD = 0.05; // seconds
    const trackClips = clips
      .filter((c) => c.trackId === trackId)
      .sort((a, b) => a.start - b.start);
    if (trackClips.length < 2) return;
    const updated = [...clips];
    for (let i = 1; i < trackClips.length; i++) {
      const prev = updated.find((c) => c.id === trackClips[i - 1].id);
      const curr = updated.find((c) => c.id === trackClips[i].id);
      if (!prev || !curr) continue;
      const prevEnd = prev.start + prev.duration;
      const gap = curr.start - prevEnd;
      if (gap > -GAP_THRESHOLD && gap < GAP_THRESHOLD && Math.abs(gap) > 0.001) {
        const idx = updated.findIndex((c) => c.id === curr.id);
        updated[idx] = { ...curr, start: Number(prevEnd.toFixed(3)) };
      }
    }
    set({ clips: updated });
  },
}));
