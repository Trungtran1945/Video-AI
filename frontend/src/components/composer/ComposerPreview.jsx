import React, { useRef, useEffect, useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Volume2,
  VolumeX,
  Sparkles,
  Maximize2,
  Minimize2,
  FastForward,
  Rewind,
  Film,
} from 'lucide-react';

export function getOverlayStyle(clip) {
  const meta = clip.meta || {};
  const fit = meta.fit || 'contain';
  const autoFit = meta.autoFit !== false;
  const scale = Number.isFinite(Number(meta.scale)) ? Number(meta.scale) : 1.0;
  const rawPosX = Number.isFinite(Number(meta.posX)) ? Number(meta.posX) : (Number.isFinite(Number(meta.x)) ? Number(meta.x) : 0);
  const rawPosY = Number.isFinite(Number(meta.posY)) ? Number(meta.posY) : (Number.isFinite(Number(meta.y)) ? Number(meta.y) : 0);
  const align = String(meta.align || 'center').toLowerCase().replace(/[\s_]+/g, '-');
  const opacity = Number.isFinite(Number(meta.opacity)) ? Number(meta.opacity) : 1.0;

  // Base anchors matching FFmpeg composerRender.js
  let baseTop = '50%';
  let baseLeft = '50%';
  let baseTranslateX = '-50%';
  let baseTranslateY = '-50%';

  if (align === 'top-left' || align === 'topleft') {
    baseTop = '0%';
    baseLeft = '0%';
    baseTranslateX = '0%';
    baseTranslateY = '0%';
  } else if (align === 'top' || align === 'top-center' || align === 'topcenter') {
    baseTop = '0%';
    baseLeft = '50%';
    baseTranslateX = '-50%';
    baseTranslateY = '0%';
  } else if (align === 'top-right' || align === 'topright') {
    baseTop = '0%';
    baseLeft = '100%';
    baseTranslateX = '-100%';
    baseTranslateY = '0%';
  } else if (align === 'left' || align === 'center-left' || align === 'centerleft') {
    baseTop = '50%';
    baseLeft = '0%';
    baseTranslateX = '0%';
    baseTranslateY = '-50%';
  } else if (align === 'right' || align === 'center-right' || align === 'centerright') {
    baseTop = '50%';
    baseLeft = '100%';
    baseTranslateX = '-100%';
    baseTranslateY = '-50%';
  } else if (align === 'bottom-left' || align === 'bottomleft') {
    baseTop = '100%';
    baseLeft = '0%';
    baseTranslateX = '0%';
    baseTranslateY = '-100%';
  } else if (align === 'bottom' || align === 'bottom-center' || align === 'bottomcenter') {
    baseTop = '100%';
    baseLeft = '50%';
    baseTranslateX = '-50%';
    baseTranslateY = '-100%';
  } else if (align === 'bottom-right' || align === 'bottomright') {
    baseTop = '100%';
    baseLeft = '100%';
    baseTranslateX = '-100%';
    baseTranslateY = '-100%';
  }

  // Anchor offset is calculated on parent container canvas space (matching FFmpeg finalX = baseX + normX * width)
  const top = `calc(${baseTop} + ${rawPosY}%)`;
  const left = `calc(${baseLeft} + ${rawPosX}%)`;
  const transform = `translate(${baseTranslateX}, ${baseTranslateY}) scale(${scale})`;

  return {
    wrapperStyle: {
      position: 'absolute',
      top,
      left,
      transform,
      transformOrigin: 'center center',
      opacity,
      width: fit === 'cover' || fit === 'fill' ? '100%' : 'auto',
      height: fit === 'cover' || fit === 'fill' ? '100%' : 'auto',
      maxWidth: fit === 'cover' || fit === 'fill' ? '100%' : (autoFit ? '100%' : 'none'),
      maxHeight: fit === 'cover' || fit === 'fill' ? '100%' : (autoFit ? '100%' : 'none'),
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'none',
      transition: 'opacity 0.15s ease',
    },
    mediaClass: `${
      fit === 'cover'
        ? 'w-full h-full object-cover'
        : fit === 'fill'
        ? 'w-full h-full object-fill'
        : 'max-w-full max-h-full object-contain'
    } rounded-lg shadow-md`,
  };
}

export default function ComposerPreview({
  project,
  clips = [],
  assets = [],
  tracks = [],
  currentTime = 0,
  duration = 10,
  isPlaying = false,
  outputUrl = null,
  onTogglePlay,
  onSeek,
}) {
  const containerRef = useRef(null);
  const audioRef = useRef(null);
  const bgmAudioRef = useRef(null);
  const sfxAudioRef = useRef(null);
  const videoRef = useRef(null);
  const bgVideoRef = useRef(null);
  const visualVideoRef = useRef(null);
  const visualVideoMapRef = useRef(new Map()); // Map<clipId, HTMLVideoElement>

  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [previewMode, setPreviewMode] = useState(outputUrl ? 'video' : 'canvas');
  const [videoLoadError, setVideoLoadError] = useState(false);

  useEffect(() => {
    if (outputUrl) {
      setPreviewMode('video');
      setVideoLoadError(false);
    }
  }, [outputUrl]);

  // Sync muted state dynamically to all media elements
  useEffect(() => {
    [audioRef, bgmAudioRef, sfxAudioRef, visualVideoRef, bgVideoRef].forEach((ref) => {
      if (ref?.current) {
        ref.current.muted = muted;
      }
    });
  }, [muted]);

  const safeAssets = Array.isArray(assets)
    ? assets
    : (assets?.assets && Array.isArray(assets.assets) ? assets.assets : []);
  const assetMap = new Map(safeAssets.filter(Boolean).map((a) => [a.id, a]));

  const voiceTrack = (tracks || []).find((t) => (t.track_type || t.type) === 'voiceover');
  const musicTrack = (tracks || []).find((t) => (t.track_type || t.type) === 'music');
  const sfxTrack = (tracks || []).find((t) => (t.track_type || t.type) === 'sfx');
  const videoTrack = (tracks || []).find((t) => (t.track_type || t.type) === 'video');

  const isVoiceMuted = Boolean(voiceTrack?.muted || voiceTrack?.isMuted) || muted;
  const isMusicMuted = Boolean(musicTrack?.muted || musicTrack?.isMuted) || muted;
  const isSfxMuted = Boolean(sfxTrack?.muted || sfxTrack?.isMuted) || muted;
  const isVideoTrackMuted = Boolean(videoTrack?.muted || videoTrack?.isMuted) || muted;

  const voiceTrackVol = Number.isFinite(Number(voiceTrack?.volume)) ? Number(voiceTrack.volume) : 1.0;
  const musicTrackVol = Number.isFinite(Number(musicTrack?.volume)) ? Number(musicTrack.volume) : 1.0;
  const sfxTrackVol = Number.isFinite(Number(sfxTrack?.volume)) ? Number(sfxTrack.volume) : 1.0;
  const videoTrackVol = Number.isFinite(Number(videoTrack?.volume)) ? Number(videoTrack.volume) : 1.0;

  // Find active clips at currentTime
  const activeClips = clips.filter((c) => {
    const start = Number(c.start ?? c.start_at_sec ?? 0);
    const dur = Number(c.duration ?? c.out_sec ?? 4);
    return currentTime >= start && currentTime < start + dur;
  });

  const activeVisualClips = activeClips.filter(
    (c) =>
      c.clip_type === 'video' ||
      c.clip_type === 'image' ||
      (!c.clip_type && (c.type === 'video' || c.type === 'image'))
  );
  const activeBgClip = activeClips.find(
    (c) => c.clip_type === 'background' || (!c.clip_type && c.type === 'background')
  );
  const activeTextClips = activeClips.filter(
    (c) => c.clip_type === 'text' || (!c.clip_type && c.type === 'text') || Boolean(c.textContent || c.text_content)
  );

  // Background visual layer
  const bgAsset = activeBgClip
    ? assetMap.get(activeBgClip.asset_id || activeBgClip.assetId)
    : null;
  const defaultBgColor = project?.params?.defaultBackground || '#0F1117';
  const bgUrl = bgAsset?.url || activeBgClip?.url || bgAsset?.thumbnailUrl;
  const isBgVideo = Boolean(
    bgAsset?.mimeType?.startsWith('video/') ||
    bgAsset?.mime_type?.startsWith('video/') ||
    activeBgClip?.mimeType?.startsWith('video/') ||
    activeBgClip?.mime_type?.startsWith('video/') ||
    activeBgClip?.meta?.isVideo ||
    (bgUrl && /\.(mp4|webm|mov|mkv)(\?.*)?$/i.test(bgUrl))
  );

  const bgFit =
    activeBgClip?.meta?.fit === 'contain' || activeBgClip?.meta?.fit === 'smart'
      ? 'object-contain'
      : 'object-cover';
  const bgLoop = activeBgClip?.meta?.loop !== false;
  const bgMuted = (activeBgClip?.meta?.muted !== false) || muted;
  const bgOpacity = typeof activeBgClip?.meta?.opacity === 'number' ? activeBgClip.meta.opacity : 0.7;

  // Background video playback sync
  useEffect(() => {
    if (!bgVideoRef.current || !isBgVideo) return;
    if (isPlaying) {
      bgVideoRef.current.play().catch(() => {});
    } else {
      bgVideoRef.current.pause();
    }
  }, [isPlaying, isBgVideo]);

  useEffect(() => {
    if (!bgVideoRef.current || !isBgVideo) return;
    const dur = bgVideoRef.current.duration;
    if (Number.isFinite(dur) && dur > 0) {
      const loopedTime = bgLoop ? (currentTime % dur) : Math.min(currentTime, dur);
      if (Math.abs(bgVideoRef.current.currentTime - loopedTime) > 0.08) {
        bgVideoRef.current.currentTime = loopedTime;
      }
    }
  }, [currentTime, isBgVideo, bgLoop]);

  // Synchronize playback & volume across all active visual videos
  useEffect(() => {
    for (const [clipId, vEl] of visualVideoMapRef.current.entries()) {
      if (!vEl) continue;
      const clip = activeVisualClips.find((c) => c.id === clipId);
      if (!clip || !isPlaying) {
        vEl.pause();
      } else {
        vEl.play().catch(() => {});
      }
    }
  }, [isPlaying, activeVisualClips]);

  useEffect(() => {
    for (const [clipId, vEl] of visualVideoMapRef.current.entries()) {
      if (!vEl) continue;
      const clip = activeVisualClips.find((c) => c.id === clipId);
      if (!clip) continue;
      const clipStart = Number(clip.start ?? clip.start_at_sec ?? 0);
      const inSec = Number(clip.in_sec || 0);
      const speed = Number(clip.speed || 1);
      const offset = inSec + Math.max(0, currentTime - clipStart) * speed;
      if (Math.abs(vEl.currentTime - offset) > 0.08) {
        vEl.currentTime = offset;
      }
      try {
        vEl.playbackRate = speed;
      } catch {}
      const clipVol = Number.isFinite(Number(clip.volume)) ? Number(clip.volume) : 1.0;
      vEl.muted = isVideoTrackMuted;
      vEl.volume = isVideoTrackMuted ? 0 : Math.max(0, Math.min(1.0, clipVol * videoTrackVol));
    }
  }, [currentTime, activeVisualClips, isVideoTrackMuted, videoTrackVol]);

  // Dynamic Aspect ratio & dimensions
  const params = project?.params || {};
  const aspectRatio = project?.aspect_ratio || project?.aspectRatio || params.aspectRatio || '16:9';
  const projectWidth = Number(params.width) || (aspectRatio === '9:16' ? 1080 : aspectRatio === '1:1' ? 1080 : aspectRatio === '4:3' ? 1440 : aspectRatio === '3:4' ? 1080 : aspectRatio === '4:5' ? 1080 : aspectRatio === '21:9' ? 2560 : 1920);
  const projectHeight = Number(params.height) || (aspectRatio === '9:16' ? 1920 : aspectRatio === '1:1' ? 1080 : aspectRatio === '4:3' ? 1080 : aspectRatio === '3:4' ? 1440 : aspectRatio === '4:5' ? 1350 : aspectRatio === '21:9' ? 1080 : 1080);

  const numericRatio = React.useMemo(() => {
    if (projectWidth > 0 && projectHeight > 0) {
      return projectWidth / projectHeight;
    }
    if (aspectRatio === '9:16') return 9 / 16;
    if (aspectRatio === '1:1') return 1;
    if (aspectRatio === '4:3') return 4 / 3;
    if (aspectRatio === '3:4') return 3 / 4;
    if (aspectRatio === '4:5') return 4 / 5;
    if (aspectRatio === '21:9') return 21 / 9;
    return 16 / 9;
  }, [aspectRatio, projectWidth, projectHeight]);

  const isPortrait = numericRatio < 1.0;
  const frameContainerStyle = {
    aspectRatio: `${projectWidth} / ${projectHeight}`,
    maxHeight: isPortrait ? 'min(560px, 68vh)' : 'min(480px, 60vh)',
    maxWidth: '100%',
    width: 'auto',
    backgroundColor: defaultBgColor,
  };

  // Dynamic audio pool to support multi-track, overlapping audio clips without dropouts
  const audioPoolRef = useRef(new Map()); // Map<clipId, HTMLAudioElement>

  const activeAudioClips = React.useMemo(() => {
    return activeClips.filter((c) => {
      const type = c.clip_type || c.type;
      return type === 'voiceover' || type === 'music' || type === 'sfx';
    });
  }, [activeClips]);

  // Synchronize audio playback for all active audio clips
  useEffect(() => {
    const currentPool = audioPoolRef.current;
    const activeIds = new Set(activeAudioClips.map((c) => c.id));

    // Pause and cleanup inactive clips
    for (const [id, audioEl] of currentPool.entries()) {
      if (!activeIds.has(id) || !isPlaying) {
        try {
          audioEl.pause();
        } catch {}
        if (!activeIds.has(id)) {
          audioEl.src = '';
          currentPool.delete(id);
        }
      }
    }

    if (!isPlaying || previewMode === 'video') return;

    const hasVoice = activeAudioClips.some((c) => (c.clip_type || c.type) === 'voiceover');

    for (const clip of activeAudioClips) {
      const type = clip.clip_type || clip.type;
      const asset = assetMap.get(
        clip.audio_id || clip.voice_audio_id || clip.audioId || clip.asset_id || clip.assetId
      );
      const audioUrl = asset?.url;
      if (!audioUrl) continue;

      let isTrackMuted = muted;
      let trackVol = 1.0;
      if (type === 'voiceover') {
        isTrackMuted = isVoiceMuted;
        trackVol = voiceTrackVol;
      } else if (type === 'music') {
        isTrackMuted = isMusicMuted;
        trackVol = musicTrackVol;
      } else if (type === 'sfx') {
        isTrackMuted = isSfxMuted;
        trackVol = sfxTrackVol;
      }

      if (isTrackMuted || trackVol <= 0) {
        const existing = currentPool.get(clip.id);
        if (existing && !existing.paused) {
          existing.pause();
        }
        continue;
      }

      let el = currentPool.get(clip.id);
      if (!el) {
        el = new Audio();
        el.preload = 'auto';
        currentPool.set(clip.id, el);
      }

      const clipStart = Number(clip.start ?? clip.start_at_sec ?? 0);
      const inSec = Number(clip.in_sec || 0);
      const speed = Number(clip.speed || 1);
      const offset = inSec + Math.max(0, currentTime - clipStart) * speed;

      // Check src change
      const fullUrl = audioUrl.startsWith('http') ? audioUrl : window.location.origin + audioUrl;
      if (el.src !== fullUrl && !el.src.endsWith(audioUrl)) {
        el.src = audioUrl;
        const seekOnReady = () => {
          try {
            el.currentTime = offset;
            el.playbackRate = speed;
          } catch {}
          el.removeEventListener('loadedmetadata', seekOnReady);
        };
        el.addEventListener('loadedmetadata', seekOnReady, { once: true });
      } else if (Math.abs(el.currentTime - offset) > 0.08) {
        try {
          el.currentTime = offset;
          el.playbackRate = speed;
        } catch {}
      } else {
        try {
          el.playbackRate = speed;
        } catch {}
      }

      // Loop setting
      if (type === 'music') {
        el.loop = clip?.meta?.loop !== false;
      }

      // Volume scaling and ducking
      const clipVol = Number.isFinite(Number(clip.volume)) ? Number(clip.volume) : (type === 'music' ? 0.8 : 1.0);
      let effectiveVol = clipVol * trackVol;
      if (type === 'music' && hasVoice) {
        effectiveVol *= 0.3; // Dynamic ducking during voiceover
      }
      el.muted = isTrackMuted;
      el.volume = Math.max(0, Math.min(1.0, effectiveVol));

      if (el.paused) {
        el.play().catch(() => {});
      }
    }
  }, [currentTime, isPlaying, activeAudioClips, assetMap, muted, isVoiceMuted, isMusicMuted, isSfxMuted, voiceTrackVol, musicTrackVol, sfxTrackVol]);

  // Clean up media on pause (pause only, do NOT wipe src which would blank the video canvas)
  useEffect(() => {
    if (!isPlaying) {
      if (audioPoolRef.current) {
        for (const el of audioPoolRef.current.values()) {
          try { el.pause(); } catch {}
        }
      }
      if (visualVideoMapRef.current) {
        for (const vEl of visualVideoMapRef.current.values()) {
          try {
            vEl.pause();
          } catch {}
        }
      }
      [audioRef, bgmAudioRef, sfxAudioRef, videoRef, bgVideoRef, visualVideoRef].forEach((ref) => {
        if (ref?.current) {
          try {
            ref.current.pause();
          } catch {}
        }
      });
    }
  }, [isPlaying]);

  // Synchronize rendered MP4 video element when previewMode is 'video'
  useEffect(() => {
    if (previewMode !== 'video' || !videoRef.current) return;
    const v = videoRef.current;
    if (isPlaying) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [isPlaying, previewMode]);

  useEffect(() => {
    if (previewMode !== 'video' || !videoRef.current) return;
    const v = videoRef.current;
    if (Math.abs(v.currentTime - currentTime) > 0.15) {
      try {
        v.currentTime = currentTime;
      } catch {}
    }
  }, [currentTime, previewMode]);

  // Clean up all media elements on unmount
  useEffect(() => {
    return () => {
      if (audioPoolRef.current) {
        for (const el of audioPoolRef.current.values()) {
          try {
            el.pause();
            el.src = '';
          } catch {}
        }
        audioPoolRef.current.clear();
      }
      if (visualVideoMapRef.current) {
        for (const vEl of visualVideoMapRef.current.values()) {
          try {
            vEl.pause();
            vEl.src = '';
          } catch {}
        }
        visualVideoMapRef.current.clear();
      }
      [audioRef, bgmAudioRef, sfxAudioRef, videoRef, bgVideoRef, visualVideoRef].forEach((ref) => {
        if (ref?.current) {
          try {
            ref.current.pause();
            ref.current.src = '';
            ref.current.load();
          } catch {}
        }
      });
    };
  }, []);

  const fmtTime = (s) => {
    const sec = Math.max(0, Math.floor(s || 0));
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  return (
    <div className="flex flex-col h-full bg-background items-center justify-between p-4 select-none">
      <audio ref={audioRef} muted={muted} className="hidden" />
      <audio ref={bgmAudioRef} muted={muted} className="hidden" />
      <audio ref={sfxAudioRef} muted={muted} className="hidden" />

      {/* Top Info Bar */}
      <div className="w-full max-w-2xl flex items-center justify-between text-xs text-muted-foreground px-2 py-1 mb-2">
        <div className="flex items-center gap-2">
          {outputUrl ? (
            <div className="flex items-center gap-1 bg-muted p-0.5 rounded-lg border border-border text-[11px]">
              <button
                type="button"
                onClick={() => setPreviewMode('canvas')}
                className={`px-2 py-0.5 rounded font-medium transition cursor-pointer ${
                  previewMode === 'canvas'
                    ? 'bg-background text-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Dựng trực tiếp
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode('video')}
                className={`px-2 py-0.5 rounded font-medium transition cursor-pointer flex items-center gap-1 ${
                  previewMode === 'video'
                    ? 'bg-primary text-primary-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Film className="w-3 h-3" />
                <span>Video MP4</span>
              </button>
            </div>
          ) : (
            <span className="font-semibold text-foreground uppercase tracking-wider text-[11px] flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              Dựng thời gian thực
            </span>
          )}
          <span className="px-1.5 py-0.5 rounded bg-muted font-mono text-[10px] border border-border">
            {aspectRatio} ({projectWidth}×{projectHeight})
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 font-mono text-xs">
            <span className="text-foreground font-semibold">{fmtTime(currentTime)}</span>
            <span>/</span>
            <span>{fmtTime(duration)}</span>
          </div>

          <button
            type="button"
            title={isFullscreen ? 'Thu nhỏ' : 'Toàn màn hình'}
            onClick={toggleFullscreen}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition cursor-pointer"
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Main Canvas / Video Viewport */}
      <div className="flex-1 w-full flex items-center justify-center p-2 min-h-0">
        {previewMode === 'video' && outputUrl && !videoLoadError ? (
          <div
            style={frameContainerStyle}
            className="relative rounded-2xl overflow-hidden shadow-2xl border border-border/80 flex items-center justify-center bg-black transition-all"
          >
            <video
              ref={videoRef}
              src={outputUrl}
              controls
              onError={() => setVideoLoadError(true)}
              onTimeUpdate={(e) => {
                if (Math.abs(currentTime - e.target.currentTime) > 0.5) {
                  onSeek?.(e.target.currentTime);
                }
              }}
              className="w-full h-full object-contain"
            />
          </div>
        ) : (
          <div
            ref={containerRef}
            style={frameContainerStyle}
            className="relative rounded-2xl overflow-hidden shadow-2xl border border-border/80 flex items-center justify-center transition-all"
          >
            {/* Background Layer */}
            {bgUrl && (
              isBgVideo ? (
                <video
                  ref={bgVideoRef}
                  src={bgUrl}
                  autoPlay={isPlaying}
                  loop={bgLoop}
                  muted={bgMuted}
                  playsInline
                  style={{ opacity: bgOpacity }}
                  className={`absolute inset-0 w-full h-full ${bgFit} pointer-events-none transition-all`}
                />
              ) : (
                <img
                  src={bgAsset?.thumbnailUrl || bgUrl}
                  alt="Background"
                  style={{ opacity: bgOpacity }}
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  className={`absolute inset-0 w-full h-full ${bgFit} transition-all pointer-events-none`}
                />
              )
            )}

            {/* Active Visual Overlays (Multiple simultaneous image/video overlays) */}
            {activeVisualClips.length > 0 ? (
              activeVisualClips.map((clip) => {
                const asset = assetMap.get(clip.asset_id || clip.assetId);
                const url = asset?.url || clip.url || asset?.thumbnailUrl;
                if (!url) return null;

                const isVideo = Boolean(
                  clip.clip_type === 'video' ||
                  clip.type === 'video' ||
                  asset?.mime_type?.startsWith('video/') ||
                  asset?.mimeType?.startsWith('video/') ||
                  (url && /\.(mp4|webm|mov|mkv)(\?.*)?$/i.test(url))
                );

                const { wrapperStyle, mediaClass } = getOverlayStyle(clip);

                return (
                  <div key={clip.id} style={wrapperStyle} className="z-10">
                    {isVideo ? (
                      <video
                        ref={(el) => {
                          if (el) visualVideoMapRef.current.set(clip.id, el);
                          else visualVideoMapRef.current.delete(clip.id);
                        }}
                        src={url}
                        autoPlay={isPlaying}
                        playsInline
                        className={mediaClass}
                      />
                    ) : (
                      <img
                        src={url}
                        alt={clip.content || 'Visual Overlay'}
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                        className={`${mediaClass} transition-all duration-200`}
                      />
                    )}
                  </div>
                );
              })
            ) : !bgUrl ? (
              <div className="relative z-10 text-center p-6 text-muted-foreground/60 select-none">
                <Sparkles className="w-8 h-8 stroke-1 mx-auto mb-2 opacity-50" />
                <span className="text-xs">Chưa có clip hiển thị ở mốc này</span>
              </div>
            ) : null}

            {/* Text Overlay Layer (Multiple active text clips support) */}
            {activeTextClips.map((clip) => {
              const text = clip.textContent || clip.text_content || clip.content;
              if (!text) return null;

              let style = {
                fontSize: 24,
                color: '#FFFFFF',
                bg: 'rgba(0,0,0,0.65)',
                position: 'bottom',
                fontFamily: 'inherit',
              };
              try {
                if (clip.style_json) {
                  style = { ...style, ...JSON.parse(clip.style_json) };
                } else if (clip.style && typeof clip.style === 'object') {
                  style = { ...style, ...clip.style };
                }
              } catch {}

              const posClass =
                style.position === 'top'
                  ? 'top-6'
                  : style.position === 'center'
                  ? 'top-1/2 -translate-y-1/2'
                  : 'bottom-6';

              return (
                <div
                  key={clip.id}
                  className={`absolute z-20 left-4 right-4 flex justify-center pointer-events-none transition-all ${posClass}`}
                >
                  <div
                    style={{
                      fontSize: `${Math.max(14, Math.min(42, style.fontSize || 24))}px`,
                      color: style.color || '#FFFFFF',
                      backgroundColor: style.bg || 'rgba(0,0,0,0.65)',
                      fontFamily: style.fontFamily || 'inherit',
                    }}
                    className="px-4 py-2 rounded-xl backdrop-blur-xs text-center font-semibold leading-relaxed shadow-lg max-w-[85%] whitespace-pre-wrap select-none"
                  >
                    {text}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Playback Controls Footer */}
      {previewMode !== 'video' && (
        <div className="w-full max-w-xl mt-3 p-2.5 rounded-2xl bg-card border border-border shadow-sm flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onSeek?.(0)}
              title="Về đầu video"
              className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => onSeek?.(Math.max(0, currentTime - 5))}
              title="Lùi 5 giây"
              className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition cursor-pointer"
            >
              <Rewind className="w-4 h-4" />
            </button>
          </div>

          <button
            type="button"
            onClick={onTogglePlay}
            title={isPlaying ? 'Tạm dừng (Space)' : 'Phát (Space)'}
            className="w-10 h-10 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground flex items-center justify-center transition shadow-md cursor-pointer"
          >
            {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
          </button>

          <button
            type="button"
            onClick={() => onSeek?.(Math.min(duration, currentTime + 5))}
            title="Tiến 5 giây"
            className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition cursor-pointer"
          >
            <FastForward className="w-4 h-4" />
          </button>

          {/* Scrub Bar */}
          <div className="flex-1 px-2">
            <input
              type="range"
              min="0"
              max={Math.max(1, duration)}
              step="0.05"
              value={currentTime}
              onChange={(e) => onSeek?.(parseFloat(e.target.value) || 0)}
              className="w-full accent-primary h-1.5 bg-muted rounded-lg cursor-pointer"
            />
          </div>

          <button
            type="button"
            onClick={() => setMuted(!muted)}
            title={muted ? 'Bật âm thanh' : 'Tắt âm thanh'}
            className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition cursor-pointer"
          >
            {muted ? <VolumeX className="w-4 h-4 text-destructive" /> : <Volume2 className="w-4 h-4" />}
          </button>
        </div>
      )}
    </div>
  );
}
