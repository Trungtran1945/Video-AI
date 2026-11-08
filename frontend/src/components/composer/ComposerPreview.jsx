import React, { useRef, useEffect, useState } from 'react';
import { Play, Pause, RotateCcw, Volume2, VolumeX, Sparkles } from 'lucide-react';

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
  const videoRef = useRef(null);
  const bgVideoRef = useRef(null);
  const [muted, setMuted] = useState(false);
  const [previewMode, setPreviewMode] = useState(outputUrl ? 'video' : 'canvas');

  useEffect(() => {
    if (outputUrl) {
      setPreviewMode('video');
    }
  }, [outputUrl]);

  const assetMap = new Map(assets.map((a) => [a.id, a]));

  const voiceTrack = (tracks || []).find((t) => t.track_type === 'voiceover');
  const musicTrack = (tracks || []).find((t) => t.track_type === 'music');
  const isVoiceMuted = Boolean(voiceTrack?.muted);
  const isMusicMuted = Boolean(musicTrack?.muted);
  const voiceTrackVol = Number.isFinite(Number(voiceTrack?.volume)) ? Number(voiceTrack.volume) : 1.0;
  const musicTrackVol = Number.isFinite(Number(musicTrack?.volume)) ? Number(musicTrack.volume) : 1.0;

  // Find active clips at currentTime
  const activeClips = clips.filter((c) => {
    const start = Number(c.start ?? c.start_at_sec ?? 0);
    const dur = Number(c.duration ?? c.out_sec ?? 4);
    return currentTime >= start && currentTime < start + dur;
  });

  const activeImageClip = activeClips.find(
    (c) => c.clip_type === 'image' || (!c.clip_type && c.type === 'image')
  );
  const activeBgClip = activeClips.find(
    (c) => c.clip_type === 'background' || (!c.clip_type && c.type === 'background')
  );
  const activeTextClip = activeClips.find(
    (c) => c.clip_type === 'text' || Boolean(c.textContent || c.text_content)
  );
  const activeVoiceClip = activeClips.find(
    (c) => c.clip_type === 'voiceover' || (!c.clip_type && c.type === 'voiceover')
  );
  const activeBgmClip = activeClips.find(
    (c) => c.clip_type === 'music' || (!c.clip_type && c.type === 'music')
  );

  // Determine Background visual
  const bgAsset = activeBgClip ? assetMap.get(activeBgClip.asset_id || activeBgClip.assetId) : null;
  const defaultBgColor = project?.params?.defaultBackground || '#0F1117';
  const bgUrl = bgAsset?.url || activeBgClip?.url || bgAsset?.thumbnailUrl;
  const isBgVideo = Boolean(
    bgAsset?.mime_type?.startsWith('video/') ||
    activeBgClip?.mime_type?.startsWith('video/') ||
    (bgUrl && /\.(mp4|webm|mov|mkv)(\?.*)?$/i.test(bgUrl))
  );

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
      const loopedTime = currentTime % dur;
      if (Math.abs(bgVideoRef.current.currentTime - loopedTime) > 0.3) {
        bgVideoRef.current.currentTime = loopedTime;
      }
    }
  }, [currentTime, isBgVideo]);

  // Determine Image visual
  const imgAsset = activeImageClip
    ? assetMap.get(activeImageClip.asset_id || activeImageClip.assetId)
    : null;
  const imgUrl = activeImageClip?.thumbnailUrl || imgAsset?.thumbnailUrl || imgAsset?.url;

  // Determine Text Overlay
  const textContent = activeTextClip
    ? activeTextClip.textContent || activeTextClip.text_content || activeTextClip.content
    : null;
  let textStyle = { fontSize: 24, color: '#FFFFFF', bg: 'rgba(0,0,0,0.6)', position: 'bottom' };
  try {
    if (activeTextClip?.style_json) {
      textStyle = { ...textStyle, ...JSON.parse(activeTextClip.style_json) };
    } else if (activeTextClip?.style) {
      textStyle = { ...textStyle, ...activeTextClip.style };
    }
  } catch (_) {}

  // Aspect ratio class
  const aspectRatio = project?.aspect_ratio || project?.aspectRatio || '16:9';
  const aspectClass =
    aspectRatio === '9:16'
      ? 'aspect-[9/16] max-h-[520px]'
      : aspectRatio === '1:1'
      ? 'aspect-square max-h-[460px]'
      : 'aspect-[16/9] max-h-[460px]';

  // Audio sync with track mute & volume
  useEffect(() => {
    if (!audioRef.current) return;
    const voiceAsset = activeVoiceClip
      ? assetMap.get(activeVoiceClip.audio_id || activeVoiceClip.asset_id)
      : null;
    const audioUrl = voiceAsset?.url;

    if (audioUrl && isPlaying && !isVoiceMuted && voiceTrackVol > 0) {
      if (audioRef.current.src !== window.location.origin + audioUrl && !audioRef.current.src.endsWith(audioUrl)) {
        audioRef.current.src = audioUrl;
      }
      const clipStart = Number(activeVoiceClip.start ?? activeVoiceClip.start_at_sec ?? 0);
      const offset = Math.max(0, currentTime - clipStart);
      if (Math.abs(audioRef.current.currentTime - offset) > 0.3) {
        audioRef.current.currentTime = offset;
      }
      const clipVol = Number.isFinite(Number(activeVoiceClip.volume)) ? Number(activeVoiceClip.volume) : 1.0;
      audioRef.current.volume = Math.max(0, Math.min(1.0, clipVol * voiceTrackVol));
      audioRef.current.play().catch(() => {});
    } else {
      audioRef.current.pause();
    }
  }, [currentTime, isPlaying, activeVoiceClip, assetMap, isVoiceMuted, voiceTrackVol]);

  // BGM audio sync & dynamic ducking with track mute & volume
  useEffect(() => {
    if (!bgmAudioRef.current) return;
    const bgmAsset = activeBgmClip
      ? assetMap.get(activeBgmClip.audio_id || activeBgmClip.asset_id)
      : null;
    const bgmUrl = bgmAsset?.url;

    if (bgmUrl && isPlaying && !isMusicMuted && musicTrackVol > 0) {
      if (bgmAudioRef.current.src !== window.location.origin + bgmUrl && !bgmAudioRef.current.src.endsWith(bgmUrl)) {
        bgmAudioRef.current.src = bgmUrl;
      }
      const clipStart = Number(activeBgmClip.start ?? activeBgmClip.start_at_sec ?? 0);
      const offset = Math.max(0, currentTime - clipStart);
      if (Math.abs(bgmAudioRef.current.currentTime - offset) > 0.3) {
        bgmAudioRef.current.currentTime = offset;
      }
      const duckedBase = activeVoiceClip ? 0.25 : 0.8;
      const clipVol = Number.isFinite(Number(activeBgmClip.volume)) ? Number(activeBgmClip.volume) : 0.8;
      bgmAudioRef.current.volume = Math.max(0, Math.min(1.0, duckedBase * clipVol * musicTrackVol));
      bgmAudioRef.current.play().catch(() => {});
    } else {
      bgmAudioRef.current.pause();
    }
  }, [currentTime, isPlaying, activeBgmClip, activeVoiceClip, assetMap, isMusicMuted, musicTrackVol]);

  const fmtTime = (s) => {
    const sec = Math.max(0, Math.floor(s || 0));
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col h-full bg-background items-center justify-between p-4 select-none">
      <audio ref={audioRef} muted={muted} className="hidden" />
      <audio ref={bgmAudioRef} muted={muted} className="hidden" />

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
                className={`px-2 py-0.5 rounded font-medium transition cursor-pointer ${
                  previewMode === 'video'
                    ? 'bg-primary text-primary-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Video MP4
              </button>
            </div>
          ) : (
            <span className="font-semibold text-foreground uppercase tracking-wider text-[11px]">
              Dựng thời gian thực
            </span>
          )}
          <span className="px-1.5 py-0.5 rounded bg-muted font-mono text-[10px] border border-border">
            {aspectRatio}
          </span>
        </div>
        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="text-foreground font-semibold">{fmtTime(currentTime)}</span>
          <span>/</span>
          <span>{fmtTime(duration)}</span>
        </div>
      </div>

      {/* Main Canvas / Video Viewport */}
      <div className="flex-1 w-full flex items-center justify-center p-2 min-h-0">
        {previewMode === 'video' && outputUrl ? (
          <div className={`relative rounded-2xl overflow-hidden shadow-2xl border border-border/80 flex items-center justify-center bg-black ${aspectClass} w-auto max-w-full`}>
            <video
              ref={videoRef}
              src={outputUrl}
              controls
              className="w-full h-full object-contain"
            />
          </div>
        ) : (
          <div
            ref={containerRef}
            style={{ backgroundColor: defaultBgColor }}
            className={`relative rounded-2xl overflow-hidden shadow-2xl border border-border/80 flex items-center justify-center transition-all ${aspectClass} w-auto max-w-full`}
          >
            {/* Background Layer */}
            {bgUrl && (
              isBgVideo ? (
                <video
                  ref={bgVideoRef}
                  src={bgUrl}
                  autoPlay={isPlaying}
                  loop
                  muted
                  playsInline
                  className="absolute inset-0 w-full h-full object-cover opacity-60 pointer-events-none"
                />
              ) : (
                <img
                  src={bgAsset?.thumbnailUrl || bgUrl}
                  alt="Background"
                  className="absolute inset-0 w-full h-full object-cover opacity-60"
                />
              )
            )}

            {/* Active Image Layer */}
            {imgUrl ? (
              <div className="relative z-10 w-full h-full flex items-center justify-center p-4">
                <img
                  src={imgUrl}
                  alt="Active Slide"
                  className="max-w-full max-h-full object-contain rounded-lg shadow-md transition-all duration-300"
                />
              </div>
            ) : (
              <div className="relative z-10 text-center p-6 text-muted-foreground/60">
                <Sparkles className="w-8 h-8 stroke-1 mx-auto mb-2 opacity-50" />
                <span className="text-xs">Chưa có clip hiển thị ở mốc này</span>
              </div>
            )}

            {/* Text Overlay Layer */}
            {textContent && (
              <div
                className={`absolute z-20 left-4 right-4 flex justify-center pointer-events-none transition-all ${
                  textStyle.position === 'top'
                    ? 'top-6'
                    : textStyle.position === 'center'
                    ? 'top-1/2 -translate-y-1/2'
                    : 'bottom-6'
                }`}
              >
                <div
                  style={{
                    fontSize: `${Math.max(14, Math.min(36, textStyle.fontSize || 24))}px`,
                    color: textStyle.color || '#FFFFFF',
                    backgroundColor: textStyle.bg || 'rgba(0,0,0,0.65)',
                  }}
                  className="px-4 py-2 rounded-xl backdrop-blur-xs text-center font-semibold leading-relaxed shadow-lg max-w-[85%] whitespace-pre-wrap"
                >
                  {textContent}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Playback Controls Footer */}
      <div className="w-full max-w-xl mt-3 p-2.5 rounded-2xl bg-card border border-border shadow-sm flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => onSeek?.(0)}
          title="Về đầu video"
          className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition"
        >
          <RotateCcw className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={onTogglePlay}
          className="w-10 h-10 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground flex items-center justify-center transition shadow-md"
        >
          {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
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
          className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition"
        >
          {muted ? <VolumeX className="w-4 h-4 text-destructive" /> : <Volume2 className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
