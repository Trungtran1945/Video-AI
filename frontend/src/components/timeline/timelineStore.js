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

export const useTimelineStore = create((set) => ({
  // Core State
  currentTime: 0,
  // R2: viewport nhỏ khởi tạo zoom thấp để timeline vừa màn hình (clamp 15–200 giữ nguyên).
  zoomLevel: (typeof window !== 'undefined' && window.innerWidth < 640) ? 20 : 50,
  tracks: INITIAL_TRACKS,
  clips: INITIAL_CLIPS,
  selectedClipId: null,
  isDirty: false,

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
  setIsDirty: (isDirty) => set({ isDirty: Boolean(isDirty) }),

  togglePlayPause: () => set((state) => ({ isPlaying: !state.isPlaying })),
  setIsPlaying: (isPlaying) => set({ isPlaying }),

  setClips: (clips) => set({
    clips: Array.isArray(clips) ? clips.map((c) => {
      const inSec = Math.max(0, Number(c.in_sec ?? 0));
      const startSec = Math.max(0, Number(c.start ?? c.start_at_sec ?? c.start_sec ?? 0));
      const dur = Math.max(0.1, Number(c.duration ?? (c.out_sec != null ? c.out_sec - inSec : 4)));
      const outSec = Number(c.out_sec != null ? c.out_sec : (inSec + dur).toFixed(3));
      return {
        ...c,
        start: startSec,
        start_at_sec: startSec,
        in_sec: inSec,
        out_sec: outSec,
        duration: dur,
      };
    }) : [],
  }),

  setTracks: (tracks) => set({ tracks: Array.isArray(tracks) ? tracks : [] }),
  addTrack: (track) => set((state) => ({ tracks: [...state.tracks, track], isDirty: true })),
  updateTrack: (id, updates) =>
    set((state) => ({
      isDirty: true,
      tracks: state.tracks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),
  toggleTrackMute: (id) =>
    set((state) => ({
      isDirty: true,
      tracks: state.tracks.map((t) =>
        t.id === id ? { ...t, isMuted: !t.isMuted, muted: !t.muted } : t
      ),
    })),
  setTrackVolume: (id, volume) =>
    set((state) => ({
      isDirty: true,
      tracks: state.tracks.map((t) =>
        t.id === id ? { ...t, volume: Math.max(0, Math.min(2.0, volume)) } : t
      ),
    })),
  addClip: (clip) => set((state) => {
    const inSec = Math.max(0, Number(clip.in_sec ?? 0));
    const startSec = Math.max(0, Number(clip.start ?? clip.start_at_sec ?? clip.start_sec ?? 0));
    const dur = Math.max(0.1, Number(clip.duration ?? (clip.out_sec != null ? clip.out_sec - inSec : 4)));
    const outSec = Number(clip.out_sec != null ? clip.out_sec : (inSec + dur).toFixed(3));
    const c = {
      ...clip,
      start: startSec,
      start_at_sec: startSec,
      in_sec: inSec,
      out_sec: outSec,
      duration: dur,
    };
    return { clips: [...state.clips, c], isDirty: true };
  }),
  clearClips: () => set({ clips: [], selectedClipId: null, isDirty: true }),

  initTimeline: ({ clips, currentTime, tracks }) => {
    set((state) => ({
      tracks: tracks !== undefined ? tracks : state.tracks,
      clips: clips !== undefined ? (Array.isArray(clips) ? clips.map((c) => {
        const inSec = Math.max(0, Number(c.in_sec ?? 0));
        const startSec = Math.max(0, Number(c.start ?? c.start_at_sec ?? c.start_sec ?? 0));
        const dur = Math.max(0.1, Number(c.duration ?? (c.out_sec != null ? c.out_sec - inSec : 4)));
        const outSec = Number(c.out_sec != null ? c.out_sec : (inSec + dur).toFixed(3));
        return {
          ...c,
          start: startSec,
          start_at_sec: startSec,
          in_sec: inSec,
          out_sec: outSec,
          duration: dur,
        };
      }) : []) : state.clips,
      currentTime: currentTime !== undefined ? currentTime : state.currentTime,
      isDirty: false,
    }));
  },

  // Clip Modifications
  updateClip: (id, updates) => {
    set((state) => ({
      isDirty: true,
      clips: state.clips.map((clip) => {
        if (clip.id !== id) return clip;
        const merged = { ...clip, ...updates };
        if (updates.start !== undefined) {
          merged.start = Number(updates.start);
          merged.start_at_sec = Number(updates.start);
        } else if (updates.start_at_sec !== undefined) {
          merged.start = Number(updates.start_at_sec);
          merged.start_at_sec = Number(updates.start_at_sec);
        }
        if (updates.in_sec !== undefined) {
          merged.in_sec = Math.max(0, Number(updates.in_sec));
        }
        if (updates.duration !== undefined) {
          const inSec = Number(merged.in_sec ?? 0);
          merged.duration = Math.max(0.1, Number(updates.duration));
          merged.out_sec = Number((inSec + merged.duration).toFixed(3));
        } else if (updates.out_sec !== undefined) {
          const inSec = Number(merged.in_sec ?? 0);
          merged.out_sec = Number(updates.out_sec);
          merged.duration = Math.max(0.1, Number((updates.out_sec - inSec).toFixed(3)));
        }
        return merged;
      }),
    }));
  },

  splitClip: (id, splitTime) => {
    let result = false;
    set((state) => {
      const targetClip = state.clips.find((c) => c.id === id);
      if (!targetClip) return state;

      const start = Number(targetClip.start ?? targetClip.start_at_sec ?? 0);
      const inSec = Number(targetClip.in_sec ?? 0);
      const duration = Number(targetClip.duration ?? (targetClip.out_sec != null ? targetClip.out_sec - inSec : 4));
      const splitPoint = Number(splitTime);

      // Edge guard: need at least 0.15s on either side of the cut
      if (splitPoint <= start + 0.15 || splitPoint >= start + duration - 0.15) {
        return state;
      }

      const firstDuration = Number((splitPoint - start).toFixed(3));
      const secondDuration = Number((duration - firstDuration).toFixed(3));

      const firstClip = {
        ...targetClip,
        duration: firstDuration,
        out_sec: Number((inSec + firstDuration).toFixed(3)),
      };

      const secondClip = {
        ...targetClip,
        id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        start: splitPoint,
        start_at_sec: splitPoint,
        in_sec: Number((inSec + firstDuration).toFixed(3)),
        duration: secondDuration,
        out_sec: targetClip.out_sec,
        order_index: (targetClip.order_index ?? 0) + 1,
      };

      const newClips = state.clips.flatMap((c) => (c.id === id ? [firstClip, secondClip] : [c]));
      result = true;
      return {
        isDirty: true,
        clips: newClips,
        selectedClipId: secondClip.id,
      };
    });
    return result;
  },

  deleteClip: (id) => {
    set((state) => ({
      isDirty: true,
      clips: state.clips.filter((clip) => clip.id !== id),
      selectedClipId: state.selectedClipId === id ? null : state.selectedClipId,
    }));
  },
}));
