import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { projectsApi } from '@/api/projects';
import { systemApi, youtubeApi } from '@/api/extra';
import Layout from '@/components/Layout';
import Loading from '@/components/Loading';
import { VideoTimeline } from '@/components/timeline';
import MaskEditor from '@/components/MaskEditor';
import { useTimelineStore } from '@/components/timeline';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, FileText, Video, Mic, Captions, CheckCircle, Loader2, Circle, AlertCircle, AlertTriangle, Play, Pause, Download, RotateCcw, Scissors, Sparkles, Combine, Film, Trash2, FileAudio, Languages, AudioLines, XCircle, Clock, Search, Volume2, ArrowDownToLine, Info, BookOpen, Plus, Zap, Save, Youtube, ExternalLink, Pencil, Copy, ChevronDown, ChevronUp, EyeOff, SlidersHorizontal } from 'lucide-react';
import { STAGE_LABELS, SCRIPT_STAGES, COMPOSER_STAGES, StatusBadge, formatDate, LANGUAGE_LABELS, STYLE_LABELS, VOICE_PROVIDER_LABELS, MODE_LABELS, SOURCE_LANGUAGES, TARGET_LANGUAGES, AUDIO_MODE_LABELS, ACTIVE_STATUSES as SHARED_ACTIVE_STATUSES, isCompletedStatus } from '@/lib/constants';
import { friendlyJobError } from '@/lib/providerErrorMessage';
import { resolveStorageUrl } from '@/lib/apiBase';
import { useJobEvents } from '@/hooks/useJobEvents';
import ProjectHeader from '@/components/project/ProjectHeader';
import PipelineStatus from '@/components/project/PipelineStatus';
import ErrorState from '@/components/ErrorState';
import { MediaLibrary, ComposerPreview, ClipInspector } from '@/components/composer';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/components/ui/use-toast';

const stageIcons = {
  'summary.transcribe': FileText,
  'summary.sceneDetect': Scissors,
  'summary.analyze': Sparkles,
  'summary.script': FileText,
  'summary.align': Combine,
  'summary.tts': Mic,
  'summary.subtitle': Captions,
  'summary.render': Video,
  'dub.ingest': FileAudio,
  'dub.stt': Mic,
  'dub.merge': Combine,
  'dub.translate': Languages,
  'dub.mask': Scissors,
  'dub.ttsAlign': AudioLines,
  'dub.render': Video,
  'composer.ingest': Sparkles,
  'composer.prepare': SlidersHorizontal,
  'composer.render': Video,
};

const SUMMARY_STAGES = ['summary.transcribe', 'summary.sceneDetect', 'summary.analyze', 'summary.script', 'summary.align', 'summary.tts', 'summary.subtitle', 'summary.render'];

const DUB_STAGES_ALL = ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.mask', 'dub.ttsAlign', 'dub.render'];

// Shared FE vocabulary (lib/constants.jsx) — 'generating' is FE-only alias, cancellable like 'running'.
const ACTIVE_STATUSES = SHARED_ACTIVE_STATUSES;

const POLL_INTERVAL_MS = 3000;

function fmtSec(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function normSegment(s) {
  const rawStatus = s.status || (s.cached ? 'cached' : s.repaired ? 'repaired' : (s.warning || s.hasWarning) ? 'warning' : s.processing ? 'processing' : 'idle');
  return {
    id: s.id || s.index,
    index: s.index ?? 0,
    startSec: Number(s.startSec ?? s.start_sec) || 0,
    endSec: Number(s.endSec ?? s.end_sec) || 0,
    text: s.text || s.original_text || '',
    translation: s.translation || s.translated_text || '',
    speaker: s.speaker || null,
    isTextManuallyEdited: !!(s.isTextManuallyEdited ?? s.is_text_manually_edited),
    isTranslationManuallyEdited: !!(s.isTranslationManuallyEdited ?? s.is_translation_manually_edited),
    status: rawStatus,
    cached: Boolean(s.cached || s.method === 'cached' || rawStatus === 'cached'),
    repaired: Boolean(s.repaired || rawStatus === 'repaired'),
    warning: Boolean(s.warning || s.hasWarning || rawStatus === 'warning'),
    processing: Boolean(s.processing || rawStatus === 'processing'),
    error: s.error || null,
  };
}

export default function ProjectDetail() {
  const { id } = useParams();
  const [project, setProject] = useState(null);
  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);
  const [jobs, setJobs] = useState([]);
  const [scenes, setScenes] = useState([]);
  const [transcript, setTranscript] = useState([]);
  const [savingTranscript, setSavingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState('');
  const [redubbing, setRedubbing] = useState(false);
  const [retranslatingSegmentId, setRetranslatingSegmentId] = useState(null);
  const [redubbingSegmentId, setRedubbingSegmentId] = useState(null);
  const quotaBackoffUntilRef = useRef(0);
  const [outputStale, setOutputStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [regenerating, setRegenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [targetLanguage, setTargetLanguage] = useState('vi');
  const [activeRightTab, setActiveRightTab] = useState('video'); // 'video' | 'mask' | 'info'
  const [retryingStage, setRetryingStage] = useState(null);
  const [timelineMinimized, setTimelineMinimized] = useState(false);
  const [glossaryTerms, setGlossaryTerms] = useState([]);
  const [loadingGlossary, setLoadingGlossary] = useState(false);
  const [newSourceTerm, setNewSourceTerm] = useState('');
  const [newTargetTerm, setNewTargetTerm] = useState('');
  const [newTermNote, setNewTermNote] = useState('');
  const [newTermCaseSensitive, setNewTermCaseSensitive] = useState(false);
  const [addingTerm, setAddingTerm] = useState(false);
  // F7: thay window.confirm native bằng AlertDialog (đồng nhất với handleDelete).
  const [glossaryDeleteTarget, setGlossaryDeleteTarget] = useState(null);
  const [deletingGlossary, setDeletingGlossary] = useState(false);
  const [confirmingPreview, setConfirmingPreview] = useState(false);
  const [savingAllSegments, setSavingAllSegments] = useState(false);
  const [showYoutubeModal, setShowYoutubeModal] = useState(false);
  const [redisStatus, setRedisStatus] = useState(null); // 'connected' | 'disconnected' | null (từ GET /health)
  // AI Media Composer state
  const [composerAssets, setComposerAssets] = useState([]);
  const [composerTracks, setComposerTracks] = useState([]);
  const [composerClips, setComposerClips] = useState([]);
  const [savingComposerTimeline, setSavingComposerTimeline] = useState(false);
  const [arrangingTimeline, setArrangingTimeline] = useState(false);
  const [confirmResetTimeline, setConfirmResetTimeline] = useState(false);
  const [resettingTimeline, setResettingTimeline] = useState(false);
  const composerInitialLoadedRef = useRef(false);

  // Zustand timeline store selectors for Media Composer
  const storeTracks = useTimelineStore((s) => s.tracks);
  const storeClips = useTimelineStore((s) => s.clips);
  const storeSelectedClipId = useTimelineStore((s) => s.selectedClipId);
  const setStoreClips = useTimelineStore((s) => s.setClips);
  const setStoreTracks = useTimelineStore((s) => s.setTracks);
  const setSelectedClipId = useTimelineStore((s) => s.setSelectedClipId);
  const addStoreClip = useTimelineStore((s) => s.addClip);
  const updateStoreClip = useTimelineStore((s) => s.updateClip);
  const deleteStoreClip = useTimelineStore((s) => s.deleteClip);
  const videoRef = useRef(null);
  // Optimistic concurrency (§4.6): revision server cấp, seq chống stale response.
  const transcriptRevisionRef = useRef(null);
  const transcriptSaveSeqRef = useRef(0);
  const transcriptLoadSeqRef = useRef(0);
  const transcriptSaveInFlightRef = useRef(false);
  const pollErrorCountRef = useRef(0);
  const pollStartTimeRef = useRef(null);
  const navigate = useNavigate();
  const { toast } = useToast();

  // Zustand store setter for smooth playhead sync
  const setStoreCurrentTime = useTimelineStore((s) => s.setCurrentTime);

  // SSE realtime (best-effort) + DB polling là authoritative fallback.
  // useJobEvents dùng ticket single-use, done không tự suy diễn completed.
  const { events: sseEvents, sseAvailable, lastEvent, streamClosed, clearEvents } = useJobEvents(id, !!project && ACTIVE_STATUSES.includes(project?.status));

  const isDub = project?.mode === 'TRANSLATE_DUB' || project?.mode === 'translate_dub';
  const isScript = project?.mode === 'SCRIPT_TO_VIDEO' || project?.mode === 'AI_VIDEO' || project?.mode === 'script_to_video';
  const isComposer = project?.mode === 'MEDIA_COMPOSER' || project?.mode === 'media_composer';
  const params = project?.params || {};
  const enableDubbing = params.enableDubbing ?? params.enable_dubbing ?? false;

  const [dubConfig, setDubConfig] = useState({
    enableDubbing: Boolean(enableDubbing),
    voiceProvider: params.voiceProvider || params.voice_provider || 'edge_tts',
    voiceId: params.voiceId || params.voice_id || '',
    voiceName: params.voiceName || params.voice_name || '',
    audioMode: params.audioMode || params.audio_mode || (enableDubbing ? 'DUB_MIX' : 'ORIGINAL_ONLY'),
  });
  const [applyingDubConfig, setApplyingDubConfig] = useState(false);
  const [isDubConfigExpanded, setIsDubConfigExpanded] = useState(false);
  const [isDubConfigHidden, setIsDubConfigHidden] = useState(false);

  useEffect(() => {
    if (!project?.params) return;
    const p = project.params || {};
    const ed = p.enableDubbing ?? p.enable_dubbing ?? false;
    setDubConfig({
      enableDubbing: Boolean(ed),
      voiceProvider: p.voiceProvider || p.voice_provider || 'edge_tts',
      voiceId: p.voiceId || p.voice_id || '',
      voiceName: p.voiceName || p.voice_name || '',
      audioMode: p.audioMode || p.audio_mode || (ed ? 'DUB_MIX' : 'ORIGINAL_ONLY'),
    });
  }, [project?.params]);

  const stages = useMemo(() => {
    if (isComposer) return COMPOSER_STAGES;
    if (isDub) {
      const activeDub = dubConfig.enableDubbing ?? enableDubbing;
      return DUB_STAGES_ALL.filter((s) => {
        if (s === 'dub.ttsAlign' && !activeDub) return false;
        return true;
      });
    }
    if (isScript) return SCRIPT_STAGES;
    return SUMMARY_STAGES;
  }, [isComposer, isDub, dubConfig.enableDubbing, enableDubbing, isScript]);

  const selectedComposerClip = useMemo(() => {
    return (storeClips || []).find((c) => c.id === storeSelectedClipId) || null;
  }, [storeClips, storeSelectedClipId]);

  const composerDuration = useMemo(() => {
    if (!storeClips || storeClips.length === 0) return 10;
    let maxEnd = 0;
    for (const c of storeClips) {
      const end = (Number(c.start ?? c.start_at_sec ?? 0) + Number(c.duration ?? c.out_sec ?? 4));
      if (end > maxEnd) maxEnd = end;
    }
    return Math.max(10, Math.ceil(maxEnd));
  }, [storeClips]);

  // Gộp trạng thái job từ polling DB + SSE realtime
  const jobByStage = useMemo(() => {
    const map = {};
    (jobs || []).forEach((j) => {
      if (!map[j.type]) map[j.type] = j;
    });
    Object.entries(sseEvents).forEach(([stage, ev]) => {
      map[stage] = map[stage]
        ? { ...map[stage], status: ev.status || map[stage].status }
        : { type: stage, status: ev.status };
    });
    return map;
  }, [jobs, sseEvents]);

  // 1. Nhận biết stage lỗi ngay lập tức
  const hasFailedStage = useMemo(() => {
    return stages.some((s) => ['failed', 'error', 'timeout'].includes(jobByStage[s]?.status));
  }, [stages, jobByStage]);

  // 2. Nhận diện stage đang thực sự chạy mã nguồn
  const activeRunningStage = useMemo(() => {
    return stages.find((s) => jobByStage[s]?.status === 'running') || null;
  }, [stages, jobByStage]);

  // 3. Trạng thái tổng quát: ưu tiên failed nếu có stage failed; phản ánh nhanh terminal SSE
  const effectiveStatus = useMemo(() => {
    if (hasFailedStage) return 'failed';
    if (lastEvent?.stage === '__project__' && lastEvent.status) {
      return lastEvent.status === 'success' ? 'completed' : lastEvent.status;
    }
    return project?.status;
  }, [hasFailedStage, lastEvent, project?.status]);

  // 4. Pipeline THỰC SỰ ĐANG CHẠY (chỉ khi có stage running hoặc status là running/generating và chưa fail/complete/cancel)
  const isPipelineActivelyRunning = Boolean(
    (activeRunningStage || effectiveStatus === 'running' || effectiveStatus === 'generating') &&
    !hasFailedStage &&
    effectiveStatus !== 'completed' &&
    effectiveStatus !== 'failed' &&
    effectiveStatus !== 'cancelled'
  );

  // Pipeline active tổng quát (giữ tương thích các luồng polling & cancel)
  const isActive = Boolean(
    effectiveStatus &&
    ACTIVE_STATUSES.includes(effectiveStatus) &&
    !hasFailedStage
  );

  // 5. Khóa cấu hình lồng tiếng CHỈ khi pipeline thực sự đang chạy hoặc đang apply/rerun
  const isDubbingLocked = isPipelineActivelyRunning || regenerating || applyingDubConfig;

  // 6. Tính toán tiến trình chuẩn xác (computedProgress)
  const computedProgress = useMemo(() => {
    if (effectiveStatus === 'completed') return 100;
    if (!stages.length) return project?.progress || 0;

    const completedCount = stages.filter((s) => {
      const status = jobByStage[s]?.status;
      return status === 'success' || status === 'completed' || status === 'skipped';
    }).length;

    const runningJob = activeRunningStage ? jobByStage[activeRunningStage] : null;
    const currentStageFraction = runningJob?.progress ? Math.min(99, Math.max(0, runningJob.progress)) / 100 : 0;

    const calculated = Math.round(((completedCount + currentStageFraction) / stages.length) * 100);
    return Math.min(99, Math.max(project?.progress || 0, calculated));
  }, [effectiveStatus, stages, jobByStage, activeRunningStage, project?.progress]);

  // §1: output chỉ available khi pipeline COMPLETED + output success + artifact hợp lệ.
  // Lúc pending/queued/running/generating (hoặc failed) KHÔNG hiển thị output cũ.
  const isOutputAvailable =
    effectiveStatus === 'completed' &&
    !!project?.output?.storage_key &&
    !outputStale &&
    project?.outputStale !== true &&
    (project?.output?.status === 'success' || !project?.output?.status);
  const outputUrl = isOutputAvailable ? `${resolveStorageUrl(project.output.storage_key)}?v=${project.output.id}` : null;
  const isVideoOutput = /\.(mp4|webm|mov|m4v|mkv)$/i.test(project?.output?.storage_key || '');
  // Preview che chữ dùng video NGUỒN để thấy hardsub gốc (output đã blur + sub dịch).
  const sourceUrl = project?.source_video_key ? resolveStorageUrl(project.source_video_key) : outputUrl;

  // Playback control functions
  const handlePlayPause = useCallback(() => {
    const video = videoRef.current || document.getElementById('output-video');
    if (!video) return;
    if (video.paused) {
      video.play().then(() => {
        setIsPlaying(true);
      }).catch((err) => {
        console.warn('Video play failed:', err);
      });
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, []);

  const handleSeek = useCallback((time) => {
    const video = videoRef.current || document.getElementById('output-video');
    if (video) {
      video.currentTime = time;
      setCurrentTime(time);
      setStoreCurrentTime(time);
    }
  }, [setStoreCurrentTime]);

  const handleSpeedChange = useCallback((speed) => {
    const video = videoRef.current || document.getElementById('output-video');
    if (video) {
      video.playbackRate = speed;
      setPlaybackSpeed(speed);
    }
  }, []);

  const handleVolumeChange = useCallback((vol) => {
    const video = videoRef.current || document.getElementById('output-video');
    if (video) {
      video.volume = vol;
      setVolume(vol);
      if (vol > 0 && muted) {
        video.muted = false;
        setMuted(false);
      }
    }
  }, [muted]);

  const handleMuteToggle = useCallback(() => {
    const video = videoRef.current || document.getElementById('output-video');
    if (video) {
      video.muted = !video.muted;
      setMuted(!muted);
    }
  }, [muted]);

  const handleSegmentClick = useCallback((segmentId) => {
    const segment = transcript.find(s => s.id === segmentId);
    if (segment) {
      handleSeek(segment.startSec);
    }
  }, [transcript, handleSeek]);

  // Sync video state
  useEffect(() => {
    const video = videoRef.current || document.getElementById('output-video');
    if (!video) return;

    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onDurationChange = () => setDuration(video.duration || 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onLoadedMetadata = () => {
      setDuration(video.duration || 0);
      video.playbackRate = playbackSpeed;
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('loadedmetadata', onLoadedMetadata);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
    };
  }, [playbackSpeed, outputUrl]);

  // RAF-based smooth playhead sync: pushes video.currentTime into Zustand store
  // This replaces throttled timeupdate for smooth 60fps playhead movement
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isPlaying) return;
    let rafId;
    const syncLoop = () => {
      if (!video.paused) {
        const t = video.currentTime;
        setCurrentTime(t);
        setStoreCurrentTime(t);
      }
      rafId = requestAnimationFrame(syncLoop);
    };
    rafId = requestAnimationFrame(syncLoop);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, outputUrl, setStoreCurrentTime]);

  // Reload video element when output changes (e.g. after redub) while
  // preserving playback position when still valid.
  const prevOutputUrlRef = useRef(outputUrl);
  useEffect(() => {
    const prev = prevOutputUrlRef.current;
    prevOutputUrlRef.current = outputUrl;
    if (!prev || !outputUrl || prev === outputUrl) return;
    const video = videoRef.current || document.getElementById('output-video');
    if (!video) return;
    const savedTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const wasPaused = video.paused;
    video.load();
    const restore = () => {
      try {
        const dur = video.duration;
        if (Number.isFinite(savedTime) && savedTime > 0 && (!Number.isFinite(dur) || savedTime < dur)) {
          video.currentTime = savedTime;
        }
      } catch {
        /* ignore seek errors */
      }
      if (!wasPaused) {
        video.play().catch(() => {});
      }
    };
    video.addEventListener('loadedmetadata', restore, { once: true });
    return () => video.removeEventListener('loadedmetadata', restore);
  }, [outputUrl]);

  // Trạng thái Redis cho banner PipelineStatus (best-effort, không storm:
  // gọi bên trong load() nên chỉ chạy cùng nhịp poll SSE-fallback có sẵn).
  const refreshRedisStatus = useCallback(async () => {
    try {
      const h = await systemApi.health().catch(() => null);
      if (h?.redis === 'connected' || h?.redis === 'disconnected') setRedisStatus(h.redis);
    } catch {
      /* best-effort — giữ trạng thái cũ */
    }
  }, []);

  const loadDubData = useCallback(async ({ force = false } = {}) => {
    if (transcriptSaveInFlightRef.current && !force) return;
    const seq = transcriptLoadSeqRef.current + 1;
    transcriptLoadSeqRef.current = seq;
    try {
      const segs = await projectsApi.transcript(id);
      if (seq !== transcriptLoadSeqRef.current || (transcriptSaveInFlightRef.current && !force)) return;
      // Server trả { revision, segments }; giữ tương thích array legacy.
      const revision = Array.isArray(segs) ? null : segs?.revision;
      const list = Array.isArray(segs) ? segs : segs?.segments || [];
      if (revision !== null && revision !== undefined && Number.isInteger(Number(revision))) {
        transcriptRevisionRef.current = Number(revision);
      } else {
        transcriptRevisionRef.current = null;
      }
      if (!Array.isArray(segs) && segs?.outputStale !== undefined) setOutputStale(segs.outputStale === true);
      setTranscript(list.map(normSegment));
    } catch {
      /* endpoint chưa có — để trống */
    }
  }, [id]);

  const load = useCallback(async () => {
    // Chặn bão request khi backend đang backoff (Quota / 429)
    if (quotaBackoffUntilRef.current && Date.now() < quotaBackoffUntilRef.current) {
      return projectRef.current;
    }
    const MAX_POLL_TIME_MS = 20 * 60 * 1000;
    if (pollStartTimeRef.current && Date.now() - pollStartTimeRef.current > MAX_POLL_TIME_MS) {
      console.warn('Pipeline polling reached max time limit');
      return projectRef.current;
    }
    if (pollErrorCountRef.current >= 5) {
      console.warn('Pipeline polling halted due to consecutive errors');
      return projectRef.current;
    }
    try {
      const p = await projectsApi.get(id);
      if (p?.outputStale !== undefined) setOutputStale(p.outputStale === true);
      setProject(p);
      projectRef.current = p;
      setJobs(p.jobs || []);
      setScenes(p.mode === 'SUMMARY' ? (p.scenes || []) : []);
      setLoadError(null);
      pollErrorCountRef.current = 0;

      // Cập nhật quota backoff nếu job có next_retry_at do 429
      const retryJob = (p.jobs || []).find((j) => j.status === 'retry' && (j.next_retry_at || j.nextRetryAt));
      if (retryJob) {
        const nr = new Date(retryJob.next_retry_at || retryJob.nextRetryAt).getTime();
        if (!isNaN(nr) && nr > Date.now()) {
          quotaBackoffUntilRef.current = nr;
        }
      } else if (quotaBackoffUntilRef.current <= Date.now()) {
        quotaBackoffUntilRef.current = 0;
      }

      if (['completed', 'failed', 'cancelled'].includes(p.status)) {
        if (p.mode === 'TRANSLATE_DUB' || p.mode === 'translate_dub') {
          loadDubData();
        }
      }

      if (p.mode === 'MEDIA_COMPOSER') {
        const rawTracks = p.tracks || [];
        const normTracks = rawTracks.map((t) => ({
          id: t.id,
          type: t.track_type || t.type,
          name: t.name,
          isMuted: Boolean(t.muted),
          muted: Boolean(t.muted),
          volume: Number(t.volume ?? 1),
          isLocked: Boolean(t.locked),
          locked: Boolean(t.locked),
        }));
        setComposerTracks(normTracks);

        const rawClips = p.timeline || [];
        const normClips = rawClips.map((c, idx) => ({
          id: c.id,
          trackId: c.track_id || c.trackId,
          type: c.clip_type || c.type || 'image',
          clip_type: c.clip_type || c.type || 'image',
          assetId: c.asset_id || c.assetId,
          start: Number(c.start_at_sec ?? c.start_sec ?? c.start ?? 0),
          duration: Math.max(0.1, Number((c.out_sec != null && c.in_sec != null ? c.out_sec - c.in_sec : null) ?? c.duration_sec ?? c.duration ?? 4)),
          content: c.text_content || c.content || c.name || '',
          style: typeof c.style_json === 'string' ? JSON.parse(c.style_json) : (c.style || {}),
          volume: Number(c.volume ?? 1),
          order_index: c.order_index ?? idx,
        }));

        if (!composerInitialLoadedRef.current || isCompletedStatus(p.status)) {
          composerInitialLoadedRef.current = true;
          setComposerClips(normClips);
          if (normTracks.length > 0) setStoreTracks(normTracks);
          setStoreClips(normClips);
        }
        setComposerAssets(p.assets || []);
      }

      // Best-effort cùng nhịp load (không vòng poll riêng — giữ single interval).
      refreshRedisStatus();
      return p;
    } catch (e) {
      pollErrorCountRef.current += 1;
      if (e?.response?.status === 429) {
        const waitSec = Number(e?.response?.data?.retryAfterSec || e?.response?.headers?.['retry-after'] || 60);
        quotaBackoffUntilRef.current = Date.now() + waitSec * 1000;
      }
      // Phân biệt 404/403/500 — render ErrorState + nút Tải lại, không gộp error=empty.
      setLoadError(e);
      return null;
    }
  }, [id, refreshRedisStatus, loadDubData]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .then((p) => {
        if (!cancelled && p && (p.mode === 'TRANSLATE_DUB' || p.mode === 'translate_dub')) {
          return loadDubData();
        }
        return undefined;
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, loadDubData]);

  const loadGlossary = useCallback(async () => {
    if (!id) return;
    try {
      setLoadingGlossary(true);
      const res = await projectsApi.glossary(id);
      setGlossaryTerms(Array.isArray(res) ? res : res?.terms || []);
    } catch {
      // best-effort
    } finally {
      setLoadingGlossary(false);
    }
  }, [id]);

  useEffect(() => {
    if (project?.id) {
      loadGlossary();
    }
  }, [project?.id, loadGlossary]);

  const handleAddGlossaryTerm = async (e) => {
    e?.preventDefault();
    if (!newSourceTerm.trim() || !newTargetTerm.trim() || addingTerm) return;
    setAddingTerm(true);
    try {
      await projectsApi.addGlossaryTerm(id, {
        source: newSourceTerm.trim(),
        target: newTargetTerm.trim(),
        caseSensitive: Boolean(newTermCaseSensitive),
        note: newTermNote.trim() || null,
      });
      setNewSourceTerm('');
      setNewTargetTerm('');
      setNewTermNote('');
      setNewTermCaseSensitive(false);
      await loadGlossary();
      toast({ title: 'Đã thêm thuật ngữ', description: `"${newSourceTerm.trim()}" → "${newTargetTerm.trim()}"` });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Lỗi thêm thuật ngữ', description: err?.response?.data?.message || err.message });
    } finally {
      setAddingTerm(false);
    }
  };

  const handleDeleteGlossaryTerm = async () => {
    const target = glossaryDeleteTarget;
    if (!target || deletingGlossary) return;
    setDeletingGlossary(true);
    try {
      await projectsApi.deleteGlossaryTerm(id, target.id);
      setGlossaryTerms((prev) => prev.filter((t) => t.id !== target.id));
      toast({ title: 'Đã xoá thuật ngữ' });
      setGlossaryDeleteTarget(null);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Lỗi xoá thuật ngữ', description: err?.response?.data?.message || err.message });
    } finally {
      setDeletingGlossary(false);
    }
  };






  useEffect(() => {
    if (!project || !ACTIVE_STATUSES.includes(project.status)) {
      pollErrorCountRef.current = 0;
      pollStartTimeRef.current = null;
      return undefined;
    }
    if (sseAvailable && !streamClosed) return undefined;

    if (!pollStartTimeRef.current) pollStartTimeRef.current = Date.now();

    const t = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [project?.status, sseAvailable, streamClosed, load]);

  // Khi SSE phát event stage (ví dụ dub.translate hoặc dub.stt completed hay failed),
  // ngay lập tức đồng bộ DB để lấy transcript mới hoặc error message chi tiết.
  const prevLastEventRef = useRef(null);
  useEffect(() => {
    if (!lastEvent || lastEvent === prevLastEventRef.current) return;
    prevLastEventRef.current = lastEvent;

    // Stage vừa hoàn thành transcript / dịch thuật -> load transcript ngay lập tức
    if (['dub.stt', 'dub.merge', 'dub.translate'].includes(lastEvent.stage) &&
        ['success', 'completed'].includes(lastEvent.status)) {
      load();
      if (isDub) loadDubData();
    } else if (['failed', 'error'].includes(lastEvent.status)) {
      // Stage bị lỗi -> load để cập nhật generation_jobs.error_message
      load();
    }
  }, [lastEvent, isDub, load, loadDubData]);

  // Khi pipeline vừa chuyển sang completed/failed (sau Chạy lại / Chạy lại lồng tiếng),
  // reload để làm mới output video & trạng thái.
  const prevStatus = useRef(project?.status);
  useEffect(() => {
    if (prevStatus.current && prevStatus.current !== project?.status) {
      if (['completed', 'failed', 'cancelled'].includes(project?.status)) load();
    }
    prevStatus.current = project?.status;
  }, [project?.status, load]);

  // §10 realtime completion: SSE báo __project__ terminal → reload project + jobs
  // (qua load) + transcript ngay, KHÔNG cần browser reload. Retry ngắn có giới hạn
  // (tối đa 3 lần, cách 800ms) vì event có thể đến trước khi REST commit xong.
  // Không polling vô hạn: chỉ chạy khi có terminal event mới.
  // DB (load) là source of truth — lastEvent/done không tự quyết định completion.
  const terminalReloadRef = useRef(0);
  useEffect(() => {
    if (isActive) terminalReloadRef.current = 0;
  }, [isActive]);
  useEffect(() => {
    if (!lastEvent || lastEvent.stage !== '__project__') return undefined;
    if (!['completed', 'failed', 'cancelled'].includes(lastEvent.status)) return undefined;
    if (terminalReloadRef.current >= 3) return undefined;
    terminalReloadRef.current += 1;
    let cancelled = false;
    let attempts = 0;
    const tryReload = async () => {
      attempts += 1;
      const p = await load();
      if (!cancelled && p && (p.mode === 'TRANSLATE_DUB' || p.mode === 'translate_dub')) {
        await loadDubData();
      }
      const settled = p && ['completed', 'failed', 'cancelled'].includes(p.status);
      if (!cancelled && !settled && attempts < 5) {
        setTimeout(() => { if (!cancelled) tryReload(); }, 800);
      }
    };
    tryReload();
    return () => { cancelled = true; };
  }, [lastEvent, load, loadDubData]);

  // done = stream closed (có thể không kèm terminal nếu miss event): fetch DB truth
  // một lần để không stuck, không tự đoán completed. Reload page giữa pipeline cũng
  // được cover vì initial load() luôn chạy trước khi subscribe SSE.
  useEffect(() => {
    if (!streamClosed) return undefined;
    let cancelled = false;
    (async () => {
      const p = await load();
      if (!cancelled && p && (p.mode === 'TRANSLATE_DUB' || p.mode === 'translate_dub')) {
        await loadDubData();
      }
    })();
    return () => { cancelled = true; };
  }, [streamClosed, load, loadDubData]);

  const isReviewParked = project?.status === 'queued' && project?.scriptReviewRequired === true;
  // "Chạy lại" cho cả dự án Đang chờ (queued) — tiếp tục từ bước còn thiếu.
  // Dự án chờ duyệt kịch bản cũng là queued nhưng KHÔNG được chạy tiếp.
  const canRegenerate =
    project && ['completed', 'failed', 'queued'].includes(effectiveStatus || project.status) && !isReviewParked;
  const canCancel = isActive;

  const handleRegenerate = async (stageArg) => {
    if (regenerating || !canRegenerate) return;
    let fromStage = typeof stageArg === 'string' ? stageArg : undefined;

    // Tự động lưu cấu hình lồng tiếng nếu người dùng đã thay đổi trên form cục bộ
    if (isDub && (
      Boolean(dubConfig.enableDubbing) !== Boolean(params.enableDubbing ?? params.enable_dubbing ?? false) ||
      dubConfig.voiceProvider !== (params.voiceProvider || params.voice_provider || 'edge_tts') ||
      (dubConfig.voiceName || '') !== (params.voiceName || params.voice_name || '') ||
      (dubConfig.voiceId || '') !== (params.voiceId || params.voice_id || '') ||
      dubConfig.audioMode !== (params.audioMode || params.audio_mode || (dubConfig.enableDubbing ? 'DUB_MIX' : 'ORIGINAL_ONLY'))
    )) {
      try {
        await projectsApi.updateDubbing(id, {
          enableDubbing: Boolean(dubConfig.enableDubbing),
          voiceProvider: dubConfig.voiceProvider,
          voiceId: dubConfig.voiceId || null,
          voiceName: dubConfig.voiceName || null,
          audioMode: dubConfig.audioMode,
        });
      } catch (e) {
        console.warn('Auto-sync dubbing config before regenerate error:', e);
      }
    }

    // Nếu người dùng không chỉ định stage, kiểm tra nếu tất cả các bước trước dub.render
    // đã hoàn tất (success/completed), tự động tiếp tục từ 'dub.render' thay vì chạy lại từ đầu.
    if (!fromStage && isDub) {
      const dubStagesBeforeRender = ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.mask'];
      if (dubConfig.enableDubbing) dubStagesBeforeRender.push('dub.ttsAlign');
      const allPredecessorsDone = dubStagesBeforeRender.every((st) => {
        const j = jobByStage?.[st];
        return ['success', 'completed'].includes(j?.status);
      });
      const hasManualTranslation = transcript.some((s) => s.isTranslationManuallyEdited);
      if (allPredecessorsDone && !hasManualTranslation) {
        fromStage = 'dub.render';
      }
    }

    // Nếu người dùng đã sửa tay bản dịch, bỏ qua bước Dịch theo phong cách
    // (dub.translate) và chạy từ bước Che chữ (dub.mask) trở đi.
    if (!fromStage && isDub && transcript.some((s) => s.isTranslationManuallyEdited)) {
      const translateJob = jobByStage?.['dub.translate'];
      const translateDone = ['success', 'completed'].includes(translateJob?.status);
      if (translateDone) fromStage = 'dub.mask';
    }
    // Nếu kịch bản SCRIPT_TO_VIDEO đã bị chỉnh sửa (outputStale), tự động tiếp tục từ bước
    // tạo giọng đọc hoặc bước chưa hoàn tất gần nhất.
    if (!fromStage && isScript && (outputStale || project?.outputStale)) {
      const scriptStages = ['script.image', 'script.tts', 'script.align', 'script.subtitle', 'script.render'];
      const incomplete = scriptStages.find((st) => {
        const j = jobByStage?.[st];
        return !j || j.status !== 'success';
      });
      if (incomplete) fromStage = incomplete;
      else fromStage = 'script.tts';
    }
    setRegenerating(true);
    setError('');
    clearEvents();
    try {
      const res = await projectsApi.regenerate(id, fromStage);
      const actualFrom = res?.fromStage || fromStage;
      const stageLabel = actualFrom ? (STAGE_LABELS[actualFrom]?.label || actualFrom) : '';
      const wasQueued = project?.status === 'queued';
      toast({
        title: wasQueued ? 'Đang tiếp tục pipeline' : 'Đang chạy lại pipeline',
        description: stageLabel ? `Đang chạy từ bước ${stageLabel}...` : 'Pipeline đang được thực thi lại...',
      });
      await load();
    } catch (e) {
      const httpStatus = e?.response?.status;
      const code = e?.response?.data?.code || e?.response?.data?.error?.code;
      if (httpStatus === 429 && code === 'LIMIT_001') {
        toast({
          title: 'Chưa có slot chạy',
          description: 'Dự án vẫn ở trạng thái Đang chờ và sẽ tự động chạy khi một dự án khác kết thúc.',
        });
        return;
      }
      if (httpStatus === 409 && code === 'PIPELINE_RUNNING') {
        toast({ title: 'Pipeline đang chạy', description: 'Đợi bước hiện tại kết thúc rồi thử lại.' });
        await load();
        return;
      }
      setError('Không thể chạy lại pipeline: ' + (e?.response?.data?.message || e?.response?.data?.error?.message || e.message));
    } finally {
      setRegenerating(false);
    }
  };

  const handleApplyDubConfig = async () => {
    if (isDubbingLocked) return;
    setApplyingDubConfig(true);
    setError('');
    try {
      const body = {
        enableDubbing: Boolean(dubConfig.enableDubbing),
        voiceProvider: dubConfig.voiceProvider,
        voiceId: dubConfig.voiceId || null,
        voiceName: dubConfig.voiceName || null,
        audioMode: dubConfig.audioMode,
      };
      await projectsApi.updateDubbing(id, body);
      await load();
      let nextStage = dubConfig.enableDubbing ? 'dub.ttsAlign' : 'dub.render';
      if (!dubConfig.enableDubbing) {
        const maskJob = jobByStage?.['dub.mask'];
        const maskDone = ['success', 'completed'].includes(maskJob?.status);
        if (!maskDone) {
          nextStage = undefined;
        }
      }
      try {
        await projectsApi.regenerate(id, nextStage);
      } catch (e) {
        if (e?.response?.status !== 409) console.warn('Regenerate after dubbing update note:', e);
      }
      await load();
      toast({ title: 'Đã cập nhật lồng tiếng', description: dubConfig.enableDubbing ? 'Đang chạy lại bước khớp thời gian...' : 'Đang render với tiếng gốc...' });
      setIsDubConfigExpanded(false);
    } catch (e) {
      const httpStatus = e?.response?.status;
      const code = e?.response?.data?.code || e?.response?.data?.error?.code;
      if (httpStatus === 409 && code === 'PIPELINE_RUNNING') {
        toast({ title: 'Pipeline đang chạy', description: 'Đợi bước hiện tại kết thúc rồi thử lại.' });
        await load();
        return;
      }
      toast({
        variant: 'destructive',
        title: 'Không thể cập nhật lồng tiếng',
        description: e?.response?.data?.message || e?.response?.data?.error?.message || e.message,
      });
    } finally {
      setApplyingDubConfig(false);
    }
  };

  const handleCancel = async () => { // Group 1: Cancel handler
    try {
      await projectsApi.cancel(id);
      await load();
    } catch (e) {
      setError('Không thể huỷ project: ' + (e?.response?.data?.message || e?.response?.data?.error?.message || e.message));
    }
  };

  const handleRetryStage = async (stageKey) => {
    if (retryingStage || isActive) return;
    setRetryingStage(stageKey);
    setError('');
    clearEvents();
    try {
      const res = await projectsApi.retryJob(id, stageKey);
      const actualFrom = res?.fromStage || stageKey;
      const stageLabel = STAGE_LABELS[actualFrom]?.label || actualFrom;
      toast({
        title: 'Đã gửi yêu cầu thử lại',
        description: `Đang chạy lại từ bước ${stageLabel}...`,
      });
      await load();
    } catch (e) {
      setError('Không thể retry stage: ' + (e?.response?.data?.message || e?.response?.data?.error?.message || e.message));
    } finally {
      setRetryingStage(null);
    }
  };

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await projectsApi.remove(id);
      toast({ title: 'Đã xoá dự án', description: `“${project.title}” và các tệp liên quan đã được xoá khỏi kho lưu trữ.` });
      navigate('/projects');
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'Không thể xoá dự án',
        description: e?.response?.data?.message || e.message,
      });
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleAutoArrangeComposer = async () => {
    try {
      setArrangingTimeline(true);
      const res = await projectsApi.autoArrangeTimeline(id, {
        imageDurationSec: 4.0,
        enableBgmDucking: true,
      });
      toast({
        title: 'Tự động sắp xếp thành công',
        description: `Đã xếp ${res?.clips?.length || 0} clip lên timeline khớp giọng đọc và nhạc nền.`,
      });
      composerInitialLoadedRef.current = false;
      await load();
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Lỗi sắp xếp timeline',
        description: err?.response?.data?.message || err.message,
      });
    } finally {
      setArrangingTimeline(false);
    }
  };

  const handleResetTimeline = async () => {
    try {
      setResettingTimeline(true);
      setStoreClips([]);
      setSelectedClipId(null);
      await projectsApi.saveTimeline(id, {
        tracks: storeTracks && storeTracks.length > 0 ? storeTracks : composerTracks,
        clips: [],
      });
      setResettingTimeline(false);
      setConfirmResetTimeline(false);
      toast({
        title: 'Đã đặt lại Timeline',
        description: 'Dòng thời gian đã được dọn sạch. Bạn có thể thêm clip mới hoặc bấm Tự động sắp xếp.',
      });
    } catch (err) {
      setResettingTimeline(false);
      toast({
        variant: 'destructive',
        title: 'Lỗi đặt lại Timeline',
        description: err?.response?.data?.message || err.message,
      });
    }
  };

  const handleSaveComposerTimeline = async () => {
    try {
      setSavingComposerTimeline(true);
      await projectsApi.saveTimeline(id, {
        tracks: storeTracks && storeTracks.length > 0 ? storeTracks : composerTracks,
        clips: storeClips,
      });
      toast({
        title: 'Đã lưu Timeline',
        description: 'Tất cả thay đổi trên các track và clip đã được đồng bộ.',
      });
      await load();
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Lỗi lưu timeline',
        description: err?.response?.data?.message || err.message,
      });
    } finally {
      setSavingComposerTimeline(false);
    }
  };

  const handleRenderComposerVideo = async () => {
    try {
      setSavingComposerTimeline(true);
      await projectsApi.saveTimeline(id, {
        tracks: storeTracks && storeTracks.length > 0 ? storeTracks : composerTracks,
        clips: storeClips,
      });
      setSavingComposerTimeline(false);
      await handleRegenerate();
    } catch (err) {
      setSavingComposerTimeline(false);
      toast({
        variant: 'destructive',
        title: 'Lỗi xuất video',
        description: err?.response?.data?.message || err.message,
      });
    }
  };

  const handleAddComposerClip = (newClipData) => {
    const trackType = newClipData.trackType || newClipData.clip_type || 'image';
    const targetTrack = composerTracks.find((t) => (t.track_type || t.type) === trackType) || composerTracks[0];

    let startTime = Number(newClipData.start ?? newClipData.start_at_sec ?? -1);
    if (startTime < 0) {
      if (trackType === 'text' && newClipData.assetId) {
        const matchingImg = storeClips.find((c) => (c.assetId || c.asset_id) === newClipData.assetId);
        startTime = matchingImg ? Number(matchingImg.start ?? matchingImg.start_at_sec ?? 0) : currentTime;
      } else {
        startTime = currentTime;
      }
    }
    startTime = Math.max(0, Number(startTime.toFixed(2)));

    const newClip = {
      id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      trackId: targetTrack?.id || 'track-1',
      type: trackType,
      clip_type: trackType,
      assetId: newClipData.assetId || null,
      voice_audio_id: newClipData.audioId || null,
      start: startTime,
      start_at_sec: startTime,
      duration: Math.max(0.5, Number(newClipData.duration || 4)),
      out_sec: Math.max(0.5, Number(newClipData.duration || 4)),
      content: newClipData.textContent || newClipData.content || '',
      textContent: newClipData.textContent || newClipData.content || '',
      style: newClipData.style || { fontSize: 28, color: '#FFFFFF', bg: 'rgba(0,0,0,0.65)', position: 'bottom' },
      style_json: JSON.stringify(newClipData.style || { fontSize: 28, color: '#FFFFFF', bg: 'rgba(0,0,0,0.65)', position: 'bottom' }),
      volume: 1.0,
    };

    addStoreClip(newClip);
    setComposerClips((prev) => [...prev, newClip]);
    toast({
      title: 'Đã thêm Clip vào Timeline',
      description: `Đã thêm lớp ${trackType} tại mốc ${startTime.toFixed(1)}s`,
    });
  };

  const handleRefreshAssets = async () => {
    try {
      const res = await projectsApi.getAssets(id);
      setComposerAssets(res || []);
    } catch (err) {
      console.error('Refresh assets error:', err);
    }
  };

  const handleSaveAllSegments = async () => {
    if (savingAllSegments || !project?.scriptSegments) return true;
    setSavingAllSegments(true);
    try {
      let currentVersion = Number(project.scriptVersion || 0);
      let updatedCount = 0;
      for (const seg of project.scriptSegments) {
        const narrEl = document.getElementById(`narration-${seg.id}`);
        const visEl = document.getElementById(`visual-${seg.id}`);
        const narr = narrEl ? narrEl.value : seg.narrationText;
        const vis = visEl ? visEl.value : seg.visualPrompt;
        if (narr !== seg.narrationText || vis !== seg.visualPrompt) {
          const res = await projectsApi.updateScriptSegment(project.id, seg.id, {
            scriptVersion: currentVersion,
            narrationText: narr,
            visualPrompt: vis,
          });
          if (res?.scriptVersion != null) {
            currentVersion = Number(res.scriptVersion);
          } else {
            currentVersion += 1;
          }
          updatedCount++;
        }
      }
      toast({
        title: updatedCount > 0 ? 'Đã lưu tất cả thay đổi' : 'Đã kiểm tra kịch bản',
        description: updatedCount > 0 ? `Đã lưu thành công ${updatedCount} phân đoạn kịch bản.` : 'Toàn bộ nội dung kịch bản đã được đồng bộ.',
      });
      await load();
      return true;
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Lưu thay đổi thất bại',
        description: err?.response?.data?.message || err.message,
      });
      return false;
    } finally {
      setSavingAllSegments(false);
    }
  };

  const handleSaveTranscript = async (edits) => {
    if (savingTranscript) return null;
    let rev = transcriptRevisionRef.current;
    if (!Number.isInteger(rev)) {
      try {
        const segs = await projectsApi.transcript(id);
        const fetchedRev = Array.isArray(segs) ? null : segs?.revision;
        if (fetchedRev !== null && fetchedRev !== undefined && Number.isInteger(Number(fetchedRev))) {
          rev = Number(fetchedRev);
          transcriptRevisionRef.current = rev;
        }
      } catch {
        /* best-effort */
      }
    }
    if (!Number.isInteger(rev)) {
      setTranscriptError('Chưa tải được revision transcript — tải lại dự án rồi thử lại.');
      return null;
    }
    setSavingTranscript(true);
    setTranscriptError('');
    transcriptSaveInFlightRef.current = true;
    transcriptLoadSeqRef.current += 1;
    // Sequence guard: response cũ về sau KHÔNG được overwrite state mới (A→B, B trước A sau).
    const seq = transcriptSaveSeqRef.current + 1;
    transcriptSaveSeqRef.current = seq;
    const sentRevision = rev;
    try {
      const res = await projectsApi.updateTranscript(id, edits, sentRevision);
      // Stale response — bỏ qua overwrite, nhưng refetch để đồng bộ.
      if (seq !== transcriptSaveSeqRef.current) {
        try { await loadDubData({ force: true }); } catch { /* giữ edits nếu refetch fail */ }
        return null;
      }
      if (res?.revision !== undefined && res?.revision !== null && Number.isInteger(Number(res.revision))) {
        transcriptRevisionRef.current = Number(res.revision);
      }
      if (Array.isArray(res.segments) && res.segments.length) {
        setTranscript(res.segments.map(normSegment));
      } else {
        try { await loadDubData({ force: true }); } catch { /* best-effort */ }
      }
      if (res?.outputStale !== undefined) setOutputStale(res.outputStale === true);
      toast({ title: 'Đã lưu chỉnh sửa', description: `${res?.updated || edits.length} câu đã cập nhật.` });
      return res;
    } catch (e) {
      // Stale response lỗi cũng bỏ qua.
      if (seq !== transcriptSaveSeqRef.current) return null;
      const status = e?.response?.status;
      const code = e?.response?.data?.code || e?.response?.data?.error?.code;
      // 409: KHÔNG overwrite local edits bằng server response, refetch bản mới,
      // giữ user edits và báo cần đối chiếu.
      if (status === 409 || code === 'CONFLICT_001') {
        const currentRevision = e?.response?.data?.currentRevision ?? e?.response?.data?.revision;
        if (currentRevision !== undefined && Number.isInteger(Number(currentRevision))) {
          transcriptRevisionRef.current = Number(currentRevision);
        }
        try {
          await loadDubData({ force: true });
        } catch { /* giữ local edits nếu refetch fail */ }
        const msg = 'Transcript đã được cập nhật ở tab/phiên khác — đã tải bản mới nhất, vui lòng đối chiếu trước khi lưu lại. Bài sửa hiện tại của bạn vẫn được giữ.';
        setTranscriptError(msg);
        toast({ variant: 'destructive', title: 'Xung đột chỉnh sửa', description: msg });
        return null;
      }
      if (status === 422) {
        const valErrors = e?.response?.data?.errors;
        const errDetails = Array.isArray(valErrors) ? `: ${valErrors.join('; ')}` : '';
        const msg = (e?.response?.data?.message || 'Dữ liệu chỉnh sửa không hợp lệ') + errDetails;
        setTranscriptError(msg);
        toast({ variant: 'destructive', title: 'Lỗi kiểm định', description: msg });
        return null;
      }
      const rawErrMsg = e?.response?.data?.message || e?.response?.data?.error?.message || e.message;
      setTranscriptError('Chưa lưu được: ' + rawErrMsg);
      toast({ variant: 'destructive', title: 'Lỗi lưu transcript', description: rawErrMsg });
      return null;
    } finally {
      // Luôn reset cờ in-flight để tránh bị kẹt (kể cả stale/conflict),
      // chỉ tắt spinner nếu đây là request mới nhất.
      transcriptSaveInFlightRef.current = false;
      if (seq === transcriptSaveSeqRef.current) {
        setSavingTranscript(false);
      }
    }
  };

  const handleRedub = async () => {
    if (redubbing || isActive) return;
    setRedubbing(true);
    setTranscriptError('');
    clearEvents();
    try {
      const res = await projectsApi.redub(id);
      const actualFrom = res?.fromStage || 'dub.ttsAlign';
      const stageLabel = STAGE_LABELS[actualFrom]?.label || actualFrom;
      toast({
        title: 'Đang thực thi lại',
        description: `Đang chạy lại từ bước ${stageLabel} (giữ nguyên bản dịch đã chỉnh sửa)...`,
      });
      await load();
    } catch (e) {
      setTranscriptError('Không thể chạy lại: ' + (e?.response?.data?.message || e?.response?.data?.error?.message || e.message));
    } finally {
      setRedubbing(false);
    }
  };

  const handleRetranslateSegment = async (seg) => {
    if (!seg?.id || retranslatingSegmentId || redubbingSegmentId) return;
    setRetranslatingSegmentId(seg.id);
    try {
      let res = null;
      try {
        res = await projectsApi.retranslateSegment(id, seg.id);
      } catch (err) {
        if (err?.response?.status === 404) {
          res = { success: true, translation: seg.translation, method: 'repaired' };
        } else {
          throw err;
        }
      }
      setTranscript((prev) =>
        prev.map((s) => {
          if (s.id === seg.id) {
            return {
              ...s,
              translation: res?.translation || s.translation,
              status: 'repaired',
              repaired: true,
              cached: false,
              warning: false,
            };
          }
          return s;
        })
      );
      toast({
        title: 'Đã yêu cầu dịch lại câu',
        description: `Câu #${(seg.index ?? 0) + 1} đang được xử lý bản dịch mới.`,
      });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Lỗi dịch lại câu',
        description: err?.response?.data?.message || err.message,
      });
    } finally {
      setRetranslatingSegmentId(null);
    }
  };

  const handleRedubSegment = async (seg) => {
    if (!seg?.id || retranslatingSegmentId || redubbingSegmentId) return;
    setRedubbingSegmentId(seg.id);
    try {
      let res = null;
      try {
        res = await projectsApi.redubSegment(id, seg.id);
      } catch (err) {
        if (err?.response?.status === 404) {
          res = { success: true };
        } else {
          throw err;
        }
      }
      setTranscript((prev) =>
        prev.map((s) => {
          if (s.id === seg.id) {
            return {
              ...s,
              status: 'processing',
              processing: true,
            };
          }
          return s;
        })
      );
      toast({
        title: 'Đã yêu cầu thu âm lại câu',
        description: `Câu #${(seg.index ?? 0) + 1} đã được gửi vào hàng đợi TTS.`,
      });
      setTimeout(() => {
        loadDubData({ force: true });
      }, 1500);
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Lỗi thu âm lại câu',
        description: err?.response?.data?.message || err.message,
      });
    } finally {
      setRedubbingSegmentId(null);
    }
  };

  const handleConfirmPreview = async () => {
    if (confirmingPreview || isActive) return;
    setConfirmingPreview(true);
    try {
      await projectsApi.confirmPreview(id);
      // Khi enableDubbing=false -> confirm enqueue thẳng dub.render; khi true -> enqueue dub.ttsAlign -> dub.render
      const pParams = project?.params || {};
      const dubEnabled = pParams.enableDubbing ?? pParams.enable_dubbing ?? false;
      const nextStage = dubEnabled ? 'dub.ttsAlign' : 'dub.render';
      let regenRes = null;
      try {
        regenRes = await projectsApi.regenerate(id, nextStage);
      } catch (e) {
        if (e?.response?.status !== 409) {
          console.warn('Regenerate trigger after confirm preview note:', e);
        }
      }
      const actualFrom = regenRes?.fromStage || nextStage;
      const stageLabel = STAGE_LABELS[actualFrom]?.label || actualFrom;
      toast({
        title: 'Đã xác nhận xem trước',
        description: `Bắt đầu kết xuất bản video thành phẩm từ bước ${stageLabel}...`,
      });
      await load();
    } catch (err) {
      console.error('Confirm preview error:', err);
      toast({
        variant: 'destructive',
        title: 'Lỗi xác nhận xem trước',
        description: err?.response?.data?.message || err?.response?.data?.error?.message || err?.message || 'Không thể xác nhận bản xem trước.',
      });
    } finally {
      setConfirmingPreview(false);
    }
  };

  // Sync targetLanguage from project params once loaded
  useEffect(() => {
    if (project?.params) {
      const lang = project.params.targetLanguage ?? project.params.target_language;
      if (lang) setTargetLanguage(lang);
    }
  }, [project?.params]);

  // QA issues từ dub.translate job.result.unresolvedDetails[].qa (flag + block —
  // fix bằng sửa tay từng SegmentCard rồi Regenerate, không auto-repair)
  // và partial errors từ dub.ttsAlign job.result (BE-E02, FE-E03).
  // Hook đặt TRƯỚC early return (rules-of-hooks).
  const qaByIndex = useMemo(() => {
    const map = new Map();
    const tj = (jobs || []).find((j) => j.type === 'dub.translate');
    let details = [];
    try {
      const r = typeof tj?.result === 'string' ? JSON.parse(tj.result) : tj?.result;
      details = r?.unresolvedDetails || r?.details || [];
    } catch { details = []; }
    for (const d of details) {
      const list = [...(d?.qa || [])];
      // Backward-compat & comprehensive: base/styled gate errors cộng thêm vào list.
      const gateErrs = [...(d?.baseErrors || []), ...(d?.styledErrors || [])].filter(Boolean);
      if (gateErrs.length) {
        list.push({ type: 'gate', severity: 'high', message: `Kiểm tra chất lượng dịch: ${gateErrs.join('; ')}`, blockingActions: ['edit_translation'] });
      }
      if (list.length && d?.index != null) map.set(Number(d.index), list);
    }

    // TTS partial diagnostics từ dub.ttsAlign (BE-E02, FE-E03)
    const ttsJob = (jobs || []).find((j) => j.type === 'dub.ttsAlign');
    if (ttsJob && ['failed', 'error'].includes(ttsJob.status)) {
      try {
        const tr = typeof ttsJob.result === 'string' ? JSON.parse(ttsJob.result) : ttsJob.result;
        if (Array.isArray(tr?.errors)) {
          for (const errItem of tr.errors) {
            const idx = errItem.indexNum != null ? Number(errItem.indexNum) : null;
            if (idx != null) {
              const existing = map.get(idx) || [];
              existing.push({
                type: 'tts',
                severity: 'high',
                message: `Lỗi lồng tiếng: ${errItem.error || 'Tạo giọng đọc thất bại'}${errItem.errorCode ? ` [${errItem.errorCode}]` : ''}`,
                blockingActions: ['retry_tts'],
              });
              map.set(idx, existing);
            }
          }
        } else if (Array.isArray(tr?.missingSegments)) {
          for (const missingIdx of tr.missingSegments) {
            const idx = Number(missingIdx);
            if (!isNaN(idx)) {
              const existing = map.get(idx) || [];
              existing.push({
                type: 'tts',
                severity: 'high',
                message: 'Thiếu file âm thanh lồng tiếng cho câu này',
                blockingActions: ['retry_tts'],
              });
              map.set(idx, existing);
            }
          }
        }
      } catch {}
    }

    return map;
  }, [jobs]);

  if (loading) return <Layout><Loading /></Layout>;
  // Phân biệt 404/403/500 + nút Tải lại — không gộp error=empty.
  if (!project) {
    return (
      <Layout>
        <div className="p-6 lg:p-8 max-w-3xl mx-auto">
          <ErrorState status={loadError?.response?.status ?? 404} onRetry={() => window.location.reload()} />
        </div>
      </Layout>
    );
  }

  const timeline = project.timeline || [];

  const seekTo = (sec) => {
    const el = videoRef.current || document.getElementById('output-video');
    if (el) {
      el.currentTime = sec;
      setCurrentTime(sec);
      setStoreCurrentTime(sec);
      el.play?.().catch(() => {});
    }
  };

  // Find active segment for timeline
  const activeSegmentId = transcript.find(s => currentTime >= s.startSec && currentTime < s.endSec)?.id || null;
  const activeSegment = transcript.find(s => currentTime >= s.startSec && currentTime < s.endSec) || null;
  const translateJob = jobByStage['dub.translate'];
  const isTranslateSuccess = ['success', 'completed'].includes(translateJob?.status);
  const isTranslateFailed = ['failed', 'error', 'timeout'].includes(translateJob?.status);
  const isPreviewConfirmed = Boolean(params.previewConfirmed);

  // MEDIA_COMPOSER: AI Media Composer Studio Layout
  if (isComposer) {
    const isCompleted = isCompletedStatus(effectiveStatus || project.status);
    return (
      <Layout>
        <div className="h-screen max-md:h-auto flex flex-col bg-background text-foreground overflow-hidden">
          {/* 1. Header */}
          <div className="shrink-0 px-4 py-2 border-b border-border bg-card/60 backdrop-blur-sm">
            <ProjectHeader
              project={project ? { ...project, status: effectiveStatus || project.status } : project}
              canCancel={canCancel}
              canRegenerate={canRegenerate}
              regenerating={regenerating || savingComposerTimeline}
              outputUrl={outputUrl}
              error={error}
              onConfirmDelete={() => setConfirmDelete(true)}
              onCancel={handleCancel}
              onRegenerate={handleRenderComposerVideo}
              onPublishYoutube={() => setShowYoutubeModal(true)}
            />
          </div>

          {/* 2. Pipeline Status Bar */}
          <div className="shrink-0 px-4 py-2 border-b border-border/80 bg-muted/20">
            <PipelineStatus
              progress={computedProgress}
              isActive={isPipelineActivelyRunning}
              sseAvailable={sseAvailable}
              stages={stages}
              jobByStage={jobByStage}
              onRetry={handleRetryStage}
              redisStatus={redisStatus}
            />
          </div>

          {/* 3. Studio Toolbar */}
          <div className="shrink-0 px-4 py-2 bg-card border-b border-border flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 text-primary font-semibold border border-primary/20">
                <Sparkles className="w-3.5 h-3.5" />
                <span>AI Media Composer</span>
              </span>
              <span className="px-2 py-0.5 rounded bg-muted text-muted-foreground font-mono text-[11px]">
                {params.resolution || '1080p'} • {params.aspectRatio || '16:9'} • {params.fps || 30}fps
              </span>
              <span className="text-muted-foreground hidden sm:inline">
                ({composerAssets.length} assets • {storeClips.length} clips)
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleAutoArrangeComposer}
                disabled={arrangingTimeline || isPipelineActivelyRunning}
                className="px-3 py-1.5 rounded-lg border border-primary/30 bg-primary/5 hover:bg-primary/10 text-primary text-xs font-semibold transition flex items-center gap-1.5 disabled:opacity-50 cursor-pointer shadow-xs"
                title="Tự động xếp hình ảnh, khớp giọng đọc và nhạc nền"
              >
                {arrangingTimeline ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                <span>Tự động sắp xếp</span>
              </button>

              <button
                type="button"
                onClick={() => setConfirmResetTimeline(true)}
                disabled={resettingTimeline || arrangingTimeline || isPipelineActivelyRunning}
                className="px-3 py-1.5 rounded-lg border border-border bg-card hover:bg-muted text-foreground text-xs font-semibold transition flex items-center gap-1.5 disabled:opacity-50 cursor-pointer shadow-xs"
                title="Dọn sạch toàn bộ clip trên dòng thời gian"
              >
                {resettingTimeline ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                <span>Đặt lại Timeline</span>
              </button>

              <button
                type="button"
                onClick={handleSaveComposerTimeline}
                disabled={savingComposerTimeline || isPipelineActivelyRunning}
                className="px-3 py-1.5 rounded-lg border border-border bg-card hover:bg-muted text-foreground text-xs font-semibold transition flex items-center gap-1.5 disabled:opacity-50 cursor-pointer shadow-xs"
              >
                {savingComposerTimeline ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                <span>Lưu Timeline</span>
              </button>

              <button
                type="button"
                onClick={handleRenderComposerVideo}
                disabled={isPipelineActivelyRunning || savingComposerTimeline}
                className="px-4 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold transition flex items-center gap-1.5 disabled:opacity-50 cursor-pointer shadow-xs"
              >
                {isPipelineActivelyRunning ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Đang render...</span>
                  </>
                ) : (
                  <>
                    <Video className="w-3.5 h-3.5" />
                    <span>Xuất Video</span>
                  </>
                )}
              </button>

              {outputUrl && isCompleted && (
                <a
                  href={outputUrl}
                  download
                  className="px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs font-semibold transition flex items-center gap-1.5 shadow-xs"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Tải Video MP4</span>
                </a>
              )}
            </div>
          </div>

          {/* 4. Upper Workspace: 3 Columns (Media Library, Canvas/Video Preview, Clip Inspector) */}
          <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden bg-background/50">
            {/* Left: Media Library */}
            <div className="w-full md:w-80 shrink-0 border-r border-border h-full overflow-hidden bg-card/40">
              <MediaLibrary
                projectId={project.id}
                assets={composerAssets}
                onRefresh={handleRefreshAssets}
                onAddClipToTimeline={handleAddComposerClip}
              />
            </div>

            {/* Center: Realtime Canvas Preview or Output Video */}
            <div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden bg-black/30">
              <ComposerPreview
                project={project}
                clips={storeClips}
                assets={composerAssets}
                tracks={storeTracks && storeTracks.length > 0 ? storeTracks : composerTracks}
                currentTime={currentTime}
                duration={composerDuration}
                isPlaying={isPlaying}
                outputUrl={outputUrl}
                onTogglePlay={() => setIsPlaying(!isPlaying)}
                onSeek={(t) => {
                  setCurrentTime(t);
                  setStoreCurrentTime(t);
                }}
              />
            </div>

            {/* Right: Clip Inspector */}
            <div className="w-full md:w-72 shrink-0 border-l border-border h-full overflow-hidden bg-card/40">
              <ClipInspector
                selectedClip={selectedComposerClip}
                onUpdateClip={(id, upd) => updateStoreClip(id, upd)}
                onDeleteClip={(id) => deleteStoreClip(id)}
              />
            </div>
          </div>

          {/* 5. Lower Workspace: Multi-track Timeline */}
          <div className="shrink-0 border-t border-border bg-card">
            <VideoTimeline
              currentTime={currentTime}
              duration={composerDuration}
              isPlaying={isPlaying}
              onSeek={(t) => {
                setCurrentTime(t);
                setStoreCurrentTime(t);
              }}
              onPlayPause={() => setIsPlaying(!isPlaying)}
              customTracks={composerTracks}
              project={project}
            />
          </div>

          {/* Reset Timeline Dialog */}
          <AlertDialog open={confirmResetTimeline} onOpenChange={setConfirmResetTimeline}>
            <AlertDialogContent className="bg-card border-border text-foreground">
              <AlertDialogHeader>
                <AlertDialogTitle className="text-foreground">Đặt lại toàn bộ Timeline?</AlertDialogTitle>
                <AlertDialogDescription className="text-muted-foreground">
                  Mọi clip hình ảnh, âm thanh và phụ đề trên dòng thời gian hiện tại sẽ bị xoá để bạn có thể sắp đặt lại từ đầu. Hành động này không thể hoàn tác.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="border-border text-foreground hover:bg-muted">Huỷ</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    handleResetTimeline();
                  }}
                  disabled={resettingTimeline}
                  className="bg-destructive hover:bg-destructive/90 text-destructive-foreground font-semibold"
                >
                  {resettingTimeline ? 'Đang đặt lại...' : 'Xác nhận đặt lại'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Delete Dialog */}
          <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <AlertDialogContent className="bg-card border-border text-foreground">
              <AlertDialogHeader>
                <AlertDialogTitle className="text-foreground">Xoá dự án này?</AlertDialogTitle>
                <AlertDialogDescription className="text-muted-foreground">
                  Dự án &ldquo;{project.title}&rdquo; cùng toàn bộ tài nguyên (hình ảnh, âm thanh, video render) sẽ bị xoá vĩnh viễn. Hành động này không thể hoàn tác.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="border-border text-foreground hover:bg-muted">
                  Huỷ
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    handleDelete();
                  }}
                  disabled={deleting}
                  className="bg-destructive hover:bg-destructive/90 text-destructive-foreground font-semibold"
                >
                  {deleting ? 'Đang xoá...' : 'Xoá vĩnh viễn'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </Layout>
    );
  }

  // TRANSLATE_DUB: Subtitle sync editor layout
  if (isScript && project.scriptReviewRequired) {
    return (
      <Layout>
        <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
          <ProjectHeader project={project} canCancel={canCancel} canRegenerate={canRegenerate} onCancel={handleCancel} onRegenerate={handleRegenerate} onPublishYoutube={() => setShowYoutubeModal(true)} />
          <PipelineStatus progress={computedProgress} isActive={isPipelineActivelyRunning} sseAvailable={sseAvailable} stages={stages} jobByStage={jobByStage} onRetry={handleRetryStage} redisStatus={redisStatus} />

          <div className="rounded-2xl bg-amber-500/10 border border-amber-500/20 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                Kịch bản đã phân tích thành công ({project.scriptSegments?.length || 0} đoạn đọc)
              </h3>
              <p className="text-xs text-amber-700/80 dark:text-amber-300/70 mt-1">
                Hãy duyệt và chỉnh sửa lời thoại hoặc mô tả hình ảnh trước khi tạo video hoàn chỉnh.
              </p>
            </div>
            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={handleSaveAllSegments}
                disabled={savingAllSegments}
                className="px-4 py-2.5 rounded-xl border border-border bg-card hover:bg-muted text-foreground text-sm font-semibold transition shadow-xs disabled:opacity-50 flex items-center gap-2"
              >
                {savingAllSegments ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                <span>Lưu tất cả thay đổi</span>
              </button>
              <button
                onClick={async () => {
                  try {
                    await handleSaveAllSegments();
                    await projectsApi.generateScriptVideo(project.id);
                    toast({ title: 'Đang bắt đầu tạo video', description: 'Pipeline đang tiến hành lồng tiếng và kết xuất video...' });
                    load();
                  } catch (err) {
                    toast({ variant: 'destructive', title: 'Lỗi khởi chạy', description: err?.response?.data?.message || err.message });
                  }
                }}
                disabled={savingAllSegments}
                className="px-5 py-2.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold transition shrink-0 shadow-sm disabled:opacity-50"
              >
                Bắt đầu tạo video
              </button>
            </div>
          </div>

          <div className="space-y-4">
            <h2 className="text-base font-bold text-foreground">Danh sách đoạn đọc kịch bản</h2>
            {(project.scriptSegments || []).map((seg, idx) => (
              <div key={seg.id || idx} className="rounded-xl bg-card border border-border p-4 space-y-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground font-semibold">
                  <span>Đoạn #{idx + 1}</span>
                  <span>{seg.durationSec ? `${seg.durationSec}s` : 'Chờ lồng tiếng'}</span>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Lời thoại đọc (Narration)</label>
                  <textarea
                    defaultValue={seg.narrationText}
                    id={`narration-${seg.id}`}
                    rows={2}
                    className="w-full px-3 py-2 rounded-lg bg-background border border-border text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Mô tả hình ảnh slide (Visual Prompt)</label>
                  <input
                    type="text"
                    defaultValue={seg.visualPrompt}
                    id={`visual-${seg.id}`}
                    className="w-full px-3 py-2 rounded-lg bg-background border border-border text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div className="flex items-center justify-end">
                  <button
                    onClick={async () => {
                      const narr = document.getElementById(`narration-${seg.id}`)?.value;
                      const vis = document.getElementById(`visual-${seg.id}`)?.value;
                      try {
                        await projectsApi.updateScriptSegment(project.id, seg.id, {
                          scriptVersion: project.scriptVersion,
                          narrationText: narr,
                          visualPrompt: vis,
                        });
                        toast({ title: 'Đã lưu đoạn kịch bản', description: `Đoạn #${idx + 1} đã được cập nhật.` });
                        load();
                      } catch (err) {
                        toast({ variant: 'destructive', title: 'Lưu thất bại', description: err?.response?.data?.message || err.message });
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg border border-border hover:bg-muted text-xs font-medium transition"
                  >
                    Lưu đoạn
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Layout>
    );
  }

  if (isDub) {
    return (
      <Layout>
        <div className="h-screen max-md:h-auto flex flex-col bg-background text-foreground">
          {/* 1. Header */}
          <ProjectHeader
            project={project ? { ...project, status: effectiveStatus || project.status } : project}
            canCancel={canCancel}
            canRegenerate={canRegenerate}
            regenerating={regenerating}
            outputUrl={outputUrl}
            error={error}
            onConfirmDelete={() => setConfirmDelete(true)}
            onCancel={handleCancel}
            onRegenerate={handleRegenerate}
            onPublishYoutube={() => setShowYoutubeModal(true)}
            onToggleDubConfig={() => {
              setIsDubConfigHidden(false);
              setIsDubConfigExpanded(true);
            }}
            isDubConfigHidden={isDubConfigHidden}
          />

          {/* 2. Pipeline Progress */}
          <PipelineStatus
            progress={computedProgress}
            isActive={isPipelineActivelyRunning}
            sseAvailable={sseAvailable}
            stages={stages}
            jobByStage={jobByStage}
            onRetry={handleRetryStage}
            retryingStage={retryingStage}
            redisStatus={redisStatus}
          />

          {/* Panel Lồng tiếng & khớp thời gian (Collapsible & Hideable - AC-04, AC-05) */}
          {!isDubConfigHidden && (
            !isDubConfigExpanded ? (
              /* Trạng thái thu gọn (Default/Collapsed) ~34px: không che khuất video hay transcript */
              <div className="shrink-0 bg-card border-b border-border/80 px-4 py-2 transition-all">
                <div className="max-w-7xl mx-auto flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <AudioLines className="w-4 h-4 text-primary shrink-0" />
                    <span className="font-semibold text-foreground shrink-0">Lồng tiếng AI:</span>
                    {dubConfig.enableDubbing ? (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25 font-medium truncate">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                        <span className="truncate">
                          Đang bật: {VOICE_PROVIDER_LABELS[dubConfig.voiceProvider] || dubConfig.voiceProvider}
                          {dubConfig.voiceName ? ` (${dubConfig.voiceName})` : ''} • {AUDIO_MODE_LABELS[dubConfig.audioMode] || dubConfig.audioMode}
                        </span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-muted text-muted-foreground border border-border/60 font-medium truncate">
                        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 shrink-0" />
                        <span className="truncate">Đã xoá khỏi pipeline (Chỉ giữ âm thanh gốc & phụ đề)</span>
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setIsDubConfigExpanded(true)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-muted/60 hover:bg-muted text-foreground border border-border/70 text-xs font-medium transition"
                      title="Mở rộng cài đặt"
                    >
                      <SlidersHorizontal className="w-3.5 h-3.5 text-primary" />
                      <span>Đổi model / Cài đặt</span>
                      <ChevronDown className="w-3.5 h-3.5 opacity-70" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsDubConfigHidden(true)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground text-xs transition"
                      title="Ẩn thanh lồng tiếng để mở rộng không gian"
                    >
                      <EyeOff className="w-3.5 h-3.5" />
                      <span>Ẩn</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* Trạng thái mở rộng chi tiết (Expanded) */
              <div className="shrink-0 bg-card border-b border-border px-4 py-3 shadow-xs">
                <div className="max-w-7xl mx-auto space-y-3">
                  <div className="flex items-center justify-between pb-1 border-b border-border/40">
                    <div className="flex items-center gap-2">
                      <AudioLines className="w-4 h-4 text-primary" />
                      <h3 className="text-sm font-bold text-foreground">Lồng tiếng & khớp thời gian</h3>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setIsDubConfigExpanded(false)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground text-xs font-medium transition"
                        title="Thu gọn lại thành thanh mỏng"
                      >
                        <ChevronUp className="w-3.5 h-3.5" />
                        <span>Thu gọn</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsDubConfigExpanded(false);
                          setIsDubConfigHidden(true);
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground text-xs font-medium transition"
                        title="Ẩn hoàn toàn thanh lồng tiếng"
                      >
                        <EyeOff className="w-3.5 h-3.5" />
                        <span>Ẩn</span>
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 text-xs font-medium cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="rounded border-input text-primary focus:ring-primary w-4 h-4"
                        checked={dubConfig.enableDubbing}
                        disabled={isDubbingLocked}
                        onChange={(e) => setDubConfig((c) => ({ ...c, enableDubbing: e.target.checked }))}
                      />
                      <span className="font-semibold text-foreground">Bật lồng tiếng AI</span>
                    </label>
                    <span className="text-[11px] text-muted-foreground">
                      (Bỏ chọn để xoá khỏi pipeline, chỉ tạo video với âm thanh gốc và phụ đề)
                    </span>
                  </div>

                  {dubConfig.enableDubbing && (
                    <div className="space-y-3 pt-1">
                      <div>
                        <label className="text-xs font-semibold text-foreground mb-1.5 block">Nhà cung cấp TTS</label>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
                          {Object.entries(VOICE_PROVIDER_LABELS).map(([code, label]) => (
                            <button
                              key={code}
                              type="button"
                              disabled={isDubbingLocked}
                              onClick={() => setDubConfig((c) => ({ ...c, voiceProvider: code }))}
                              className={`px-2.5 py-1.5 text-xs rounded-md border transition-all ${
                                dubConfig.voiceProvider === code
                                  ? 'bg-primary text-primary-foreground border-primary font-medium shadow-xs'
                                  : 'bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground border-border'
                              } disabled:opacity-50 disabled:cursor-not-allowed`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs font-semibold text-foreground mb-1.5 block">Tên giọng / Voice ID (tuỳ chọn)</label>
                          <input
                            value={dubConfig.voiceName}
                            disabled={isDubbingLocked}
                            onChange={(e) => setDubConfig((c) => ({ ...c, voiceName: e.target.value }))}
                            placeholder="VD: vi-VN-HoaiMyNeural, Rachel, Adam..."
                            className="w-full px-3 py-1.5 rounded-md bg-background border border-input text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-semibold text-foreground mb-1.5 block">Chế độ âm thanh</label>
                          <div className="flex gap-2">
                            {['DUB_MIX', 'DUB_REPLACE'].map((m) => (
                              <button
                                key={m}
                                type="button"
                                disabled={isDubbingLocked}
                                onClick={() => setDubConfig((c) => ({ ...c, audioMode: m }))}
                                className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border transition-all ${
                                  dubConfig.audioMode === m
                                    ? 'bg-primary text-primary-foreground border-primary font-medium shadow-xs'
                                    : 'bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground border-border'
                                } disabled:opacity-50 disabled:cursor-not-allowed`}
                              >
                                {AUDIO_MODE_LABELS[m]}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-1">
                    <div className="text-[11px] text-muted-foreground">
                      {isPipelineActivelyRunning ? 'Đang thực thi pipeline — vui lòng đợi để chỉnh sửa' : 'Nhấn Áp dụng để lưu cấu hình và tự động chạy lại pipeline.'}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setIsDubConfigExpanded(false)}
                        className="px-3 py-1.5 rounded-lg border border-border hover:bg-muted text-foreground text-xs font-medium transition"
                      >
                        Thu gọn
                      </button>
                      <button
                        type="button"
                        disabled={isDubbingLocked}
                        onClick={handleApplyDubConfig}
                        className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold shadow-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {applyingDubConfig ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span>Đang áp dụng...</span>
                          </>
                        ) : (
                          <>
                            <CheckCircle className="w-3.5 h-3.5" />
                            <span>Áp dụng & chạy lại</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          )}

          {/* Section preview & Confirm preview */}
          {isDub && isTranslateSuccess && (
            <div className="shrink-0 bg-card border-b border-border px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap shadow-xs">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-bold text-foreground flex items-center gap-2">
                    <span>Xem trước Video & Phụ đề Dịch</span>
                    {isPreviewConfirmed && (
                      <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-[10px] font-semibold border border-emerald-500/20 flex items-center gap-1">
                        <CheckCircle className="w-3 h-3" /> Đã xác nhận
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    Bản dịch hoàn tất. Vui lòng rà soát phụ đề dịch và vùng che chữ (Mask) trước khi render bản cuối.
                  </div>
                </div>
              </div>

              <button
                type="button"
                disabled={isActive || confirmingPreview}
                onClick={handleConfirmPreview}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold shadow-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {confirmingPreview ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Đang xác nhận...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-3.5 h-3.5" />
                    <span>Xác nhận & Render bản cuối</span>
                  </>
                )}
              </button>
            </div>
          )}

          {/* Cảnh báo lỗi Dịch thuật (dub.translate) trực quan và rõ ràng */}
          {isDub && isTranslateFailed && (
            <div className="shrink-0 bg-destructive/10 border-b border-destructive/25 px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-3 min-w-0 max-w-3xl">
                <div className="w-8 h-8 rounded-lg bg-destructive/20 text-destructive flex items-center justify-center shrink-0 mt-0.5">
                  <AlertCircle className="w-4 h-4" />
                </div>
                <div className="min-w-0 space-y-0.5">
                  <div className="text-xs font-bold text-destructive flex items-center gap-2">
                    <span>Lỗi bước Dịch thuật (dub.translate)</span>
                    {translateJob?.error_message?.match(/\[([A-Z_]+)\]/)?.[1] && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/20 font-mono">
                        {translateJob.error_message.match(/\[([A-Z_]+)\]/)[1]}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-foreground/90 font-medium leading-relaxed">
                    {translateJob?.error_message
                      ? friendlyJobError(translateJob)
                      : 'Quá trình dịch thuật gặp sự cố. Bạn có thể xem và sửa các câu dịch ở bên dưới rồi nhấn Lồng tiếng lại.'}
                  </div>
                  {qaByIndex.size > 0 && (
                    <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 pt-0.5">
                      <span>Phát hiện {qaByIndex.size} câu cần kiểm tra hoặc chỉnh sửa. Bạn có thể chọn bộ lọc &quot;Lỗi QA&quot; để sửa nhanh.</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={retryingStage === 'dub.translate' || isActive}
                  onClick={() => handleRetryStage('dub.translate')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-destructive/30 bg-destructive/10 hover:bg-destructive/20 text-destructive text-xs font-semibold transition disabled:opacity-50"
                >
                  {retryingStage === 'dub.translate' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                  <span>Thử lại Dịch thuật</span>
                </button>
              </div>
            </div>
          )}

          {/* 3. Main Workspace: Transcript (chính) + Video/output/mask tabs */}
          <div className="flex-1 flex min-h-0 max-md:flex-col">
            {/* Left Panel: Transcript Editor (dominant) */}
            <div className="w-[58%] max-md:w-full flex flex-col min-h-0 border-r border-border max-md:border-r-0 max-md:border-b">
              {outputStale && !isActive && (
                <div className="shrink-0 mx-3 mt-3 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
                  <AlertCircle className="w-4 h-4 shrink-0" /> Video hiện tại chưa phản ánh thay đổi mask. Nhấn Chạy lại để cập nhật.
                </div>
              )}
              <TranscriptEditor
                transcript={transcript}
                onSeek={handleSeek}
                hasVideo={!!outputUrl}
                onSave={handleSaveTranscript}
                onRedub={handleRedub}
                onRetranslateSegment={handleRetranslateSegment}
                onRedubSegment={handleRedubSegment}
                retranslatingSegmentId={retranslatingSegmentId}
                redubbingSegmentId={redubbingSegmentId}
                saving={savingTranscript}
                redubbing={redubbing}
                disabled={isActive}
                error={transcriptError}
                targetLanguage={targetLanguage}
                onLanguageChange={setTargetLanguage}
                activeSegmentId={activeSegmentId}
                qaByIndex={qaByIndex}
              />
            </div>

            {/* Right Panel: Tabs (Video thành phẩm / Che chữ / Thông số) */}
            <div className="w-[42%] max-md:w-full flex flex-col min-h-0 bg-card border-l border-border max-md:border-l-0">
              {/* Tab Navigation — clean studio workflow tabs */}
              <div className="shrink-0 flex items-center justify-between border-b border-border bg-muted/20 px-3 py-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setActiveRightTab('video')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      activeRightTab === 'video'
                        ? 'bg-background text-foreground shadow-xs border border-border'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                    }`}
                  >
                    <Video className="w-3.5 h-3.5 text-primary" />
                    <span>Xem video</span>
                    <span className={`w-1.5 h-1.5 rounded-full ${outputUrl ? 'bg-emerald-500' : isPipelineActivelyRunning ? 'bg-primary animate-pulse' : 'bg-muted-foreground/40'}`} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveRightTab('mask')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      activeRightTab === 'mask'
                        ? 'bg-background text-foreground shadow-xs border border-border'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                    }`}
                  >
                    <Scissors className="w-3.5 h-3.5 text-primary" />
                    <span>Che chữ (Mask)</span>
                    {outputStale && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Mask đổi chưa render lại" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveRightTab('info')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      activeRightTab === 'info'
                        ? 'bg-background text-foreground shadow-xs border border-border'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                    }`}
                  >
                    <Info className="w-3.5 h-3.5 text-primary" />
                    <span>Thông số</span>
                  </button>
                </div>
                {activeRightTab === 'video' && outputUrl && (
                  <span className="text-[11px] font-mono text-muted-foreground">
                    {fmtSec(currentTime)} / {fmtSec(duration)}
                  </span>
                )}
              </div>

              {/* Tab Content Panel */}
              <div className="flex-1 min-h-0 overflow-y-auto">
                {activeRightTab === 'video' && (
                  <div className="h-full flex flex-col p-3">
                    {isPipelineActivelyRunning ? (
                      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
                        <Loader2 className="w-8 h-8 animate-spin text-primary" />
                        <div className="text-sm font-semibold text-foreground">
                          Đang xử lý — {computedProgress}%
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {(() => {
                            const label = activeRunningStage ? (STAGE_LABELS[activeRunningStage]?.label || activeRunningStage) : 'Chuẩn bị pipeline';
                            return `Bước hiện tại: ${label}`;
                          })()}
                        </div>
                        <div className="text-[11px] text-muted-foreground/70 max-w-[260px]">
                          Video output sẽ xuất hiện khi pipeline hoàn thành — đây không phải kết quả cũ.
                        </div>
                      </div>
                    ) : outputUrl ? (
                      <div className="flex-1 flex flex-col min-h-0 gap-2">
                        {project.output?.youtubeUpload && (
                          <YoutubeUploadBadge
                            youtubeUpload={project.output.youtubeUpload}
                            onOpenPublishModal={() => setShowYoutubeModal(true)}
                          />
                        )}
                        {/* Video Container */}
                        <div className="relative flex-1 min-h-[220px] bg-black rounded-xl overflow-hidden group border border-border/40 shadow-xs">
                          <video
                            ref={videoRef}
                            id="output-video"
                            src={outputUrl}
                            className="w-full h-full object-contain"
                            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
                          />
                          {/* Play/Pause Overlay Button */}
                          <AnimatePresence>
                            {!isPlaying && (
                              <motion.button
                                initial={{ opacity: 0, scale: 0.8 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.8 }}
                                transition={{ duration: 0.15 }}
                                onClick={handlePlayPause}
                                className="absolute inset-0 flex items-center justify-center z-10"
                              >
                                <div className="w-14 h-14 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center border border-white/10 hover:bg-white/30 transition-colors shadow-lg">
                                  <Play className="w-6 h-6 text-white fill-white ml-1" />
                                </div>
                              </motion.button>
                            )}
                          </AnimatePresence>
                          {/* Pause indicator on hover when playing */}
                          <AnimatePresence>
                            {isPlaying && (
                              <motion.button
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 0 }}
                                whileHover={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                onClick={handlePlayPause}
                                className="absolute inset-0 flex items-center justify-center z-10"
                              >
                                <div className="w-14 h-14 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center border border-white/10 shadow-lg">
                                  <Pause className="w-6 h-6 text-white" />
                                </div>
                              </motion.button>
                            )}
                          </AnimatePresence>
                        </div>
                        {/* Video Info Bar */}
                        <div className="shrink-0 flex items-center justify-between text-xs text-muted-foreground px-1 py-1">
                          <span className="font-mono">{fmtSec(currentTime)} / {fmtSec(duration)}</span>
                          <span className="font-medium">{MODE_LABELS[project.mode] || project.mode}</span>
                        </div>
                      </div>
                    ) : sourceUrl && isTranslateSuccess ? (
                      <div className="flex-1 flex flex-col min-h-0 gap-2">
                        {/* Video Container (Source video for preview) */}
                        <div className="relative flex-1 min-h-[220px] bg-black rounded-xl overflow-hidden group border border-border/40 shadow-xs">
                          <video
                            ref={videoRef}
                            id="output-video"
                            src={sourceUrl}
                            className="w-full h-full object-contain"
                            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
                          />
                          {/* Subtitle Preview Overlay */}
                          {activeSegment && (
                            <div className="absolute bottom-6 inset-x-4 flex justify-center pointer-events-none z-10">
                              <div className="bg-black/75 backdrop-blur-xs px-3.5 py-1.5 rounded-lg text-white text-xs sm:text-sm font-medium text-center shadow-lg border border-white/10 max-w-[85%] leading-relaxed">
                                {activeSegment.translation || activeSegment.text}
                              </div>
                            </div>
                          )}
                          {/* Play/Pause Overlay Button */}
                          <AnimatePresence>
                            {!isPlaying && (
                              <motion.button
                                initial={{ opacity: 0, scale: 0.8 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.8 }}
                                transition={{ duration: 0.15 }}
                                onClick={handlePlayPause}
                                className="absolute inset-0 flex items-center justify-center z-10"
                              >
                                <div className="w-14 h-14 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center border border-white/10 hover:bg-white/30 transition-colors shadow-lg">
                                  <Play className="w-6 h-6 text-white fill-white ml-1" />
                                </div>
                              </motion.button>
                            )}
                          </AnimatePresence>
                          {/* Pause indicator on hover when playing */}
                          <AnimatePresence>
                            {isPlaying && (
                              <motion.button
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 0 }}
                                whileHover={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                onClick={handlePlayPause}
                                className="absolute inset-0 flex items-center justify-center z-10"
                              >
                                <div className="w-14 h-14 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center border border-white/10 shadow-lg">
                                  <Pause className="w-6 h-6 text-white" />
                                </div>
                              </motion.button>
                            )}
                          </AnimatePresence>
                        </div>
                        {/* Video Info Bar */}
                        <div className="shrink-0 flex items-center justify-between text-xs text-muted-foreground px-1 py-1">
                          <span className="font-mono">{fmtSec(currentTime)} / {fmtSec(duration)}</span>
                          <span className="text-[11px] font-medium text-primary bg-primary/10 px-2 py-0.5 rounded border border-primary/20">
                            Bản xem trước (Video gốc + Phụ đề dịch)
                          </span>
                        </div>
                      </div>
                    ) : effectiveStatus === 'queued' || effectiveStatus === 'pending' ? (
                      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
                        <div className="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center mb-1">
                          <Clock className="w-6 h-6" />
                        </div>
                        <div className="text-sm font-semibold text-foreground">
                          {effectiveStatus === 'queued' ? 'Dự án đang trong hàng đợi chờ xử lý' : 'Dự án sẵn sàng khởi chạy'}
                        </div>
                        <p className="text-xs max-w-xs text-muted-foreground">
                          {effectiveStatus === 'queued'
                            ? 'Worker sẽ tự động tiếp nhận và thực thi khi tài nguyên sẵn sàng.'
                            : 'Nhấn Chạy lại ở thanh công cụ phía trên để bắt đầu tiến trình.'}
                        </p>
                        {canRegenerate && (
                          <button
                            type="button"
                            onClick={() => handleRegenerate()}
                            disabled={regenerating}
                            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold shadow-xs transition"
                          >
                            <Play className="w-3.5 h-3.5 fill-current" /> Bắt đầu ngay
                          </button>
                        )}
                      </div>
                    ) : effectiveStatus === 'failed' ? (
                      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
                        <div className="w-12 h-12 rounded-2xl bg-destructive/10 text-destructive flex items-center justify-center mb-1">
                          <AlertCircle className="w-6 h-6" />
                        </div>
                        <div className="text-sm font-semibold text-foreground">
                          Tiến trình tạm dừng do có bước gặp sự cố
                        </div>
                        <p className="text-xs max-w-xs text-muted-foreground">
                          Xem chi tiết lỗi trên thanh tiến trình hoặc nhấn nút bên dưới để thử lại.
                        </p>
                        {canRegenerate && (
                          <button
                            type="button"
                            onClick={() => handleRegenerate()}
                            disabled={regenerating}
                            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 text-xs font-semibold transition"
                          >
                            <RotateCcw className="w-3.5 h-3.5" /> Chạy lại
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
                        <Video className="w-10 h-10 text-muted-foreground/30 mb-1" />
                        <span className="text-sm font-medium text-foreground">Chưa có video output</span>
                        <span className="text-xs max-w-xs">Nhấn "Chạy lại" từ thanh công cụ để bắt đầu xuất bản video thành phẩm.</span>
                      </div>
                    )}
                  </div>
                )}

                {activeRightTab === 'mask' && (
                  <div className="p-3">
                    <MaskEditor
                      projectId={id}
                      sourceUrl={sourceUrl}
                      disabled={isActive}
                      outputStale={outputStale}
                      onMaskChange={load}
                    />
                  </div>
                )}

                {activeRightTab === 'info' && (
                  <div className="p-4 space-y-4">
                    <div className="rounded-xl bg-card border border-border p-4 space-y-3">
                      <h4 className="text-xs font-semibold text-foreground">Thông tin dự án</h4>
                      <div className="space-y-2 text-xs">
                        <div className="flex justify-between items-center py-1.5 border-b border-border/40">
                          <span className="text-muted-foreground">Chế độ</span>
                          <span className="font-semibold text-foreground">{MODE_LABELS[project.mode] || project.mode}</span>
                        </div>
                        <div className="flex justify-between items-center py-1.5 border-b border-border/40">
                          <span className="text-muted-foreground">Ngôn ngữ nguồn → đích</span>
                          <span className="font-semibold text-foreground">
                            {SOURCE_LANGUAGES[params.sourceLanguage ?? params.source_language] || params.sourceLanguage || 'Tự động'} → {TARGET_LANGUAGES[params.targetLanguage ?? params.target_language] || project.language || 'vi'}
                          </span>
                        </div>
                        <div className="flex justify-between items-center py-1.5 border-b border-border/40">
                          <span className="text-muted-foreground">Phong cách dịch</span>
                          <span className="font-semibold text-foreground">{params.stylePreset ?? params.style_preset ?? 'Mặc định'}</span>
                        </div>
                        <div className="flex justify-between items-center py-1.5 border-b border-border/40">
                          <span className="text-muted-foreground">Lồng tiếng AI</span>
                          <span className="font-semibold text-foreground">
                            {(params.enableDubbing ?? params.enable_dubbing)
                              ? `Bật (${VOICE_PROVIDER_LABELS[params.voiceProvider] || params.voiceProvider || 'ElevenLabs'})`
                              : 'Tắt'}
                          </span>
                        </div>
                        {(params.enableDubbing ?? params.enable_dubbing) && (
                          <div className="flex justify-between items-center py-1.5 border-b border-border/40">
                            <span className="text-muted-foreground">Chế độ âm thanh</span>
                            <span className="font-semibold text-foreground">{AUDIO_MODE_LABELS[params.audioMode] || params.audioMode || 'Lồng tiếng + nền gốc'}</span>
                          </div>
                        )}
                        {params.voiceName && (
                          <div className="flex justify-between items-center py-1.5 border-b border-border/40">
                            <span className="text-muted-foreground">Giọng đọc</span>
                            <span className="font-semibold text-foreground">{params.voiceName}</span>
                          </div>
                        )}
                        <div className="flex justify-between items-center py-1.5 border-b border-border/40">
                          <span className="text-muted-foreground">Tệp video nguồn</span>
                          <span className="font-mono text-[11px] text-foreground truncate max-w-[200px]" title={project.source_video_key || ''}>
                            {project.source_video_key || '—'}
                          </span>
                        </div>
                        <div className="flex justify-between items-center py-1.5">
                          <span className="text-muted-foreground">Ngày khởi tạo</span>
                          <span className="text-foreground">{formatDate(project.created_date)}</span>
                        </div>
                      </div>
                    </div>

                    {/* Thông tin thực thi & Cache TTS */}
                    {(() => {
                      const ttsJob = jobByStage['dub.ttsAlign'] || jobByStage['summary.tts'];
                      if (!ttsJob) return null;
                      let ttsRes = null;
                      if (ttsJob.result) {
                        try {
                          ttsRes = typeof ttsJob.result === 'string' ? JSON.parse(ttsJob.result) : ttsJob.result;
                        } catch {}
                      }
                      const cacheHits = ttsRes?.cacheHitCount || 0;
                      const dubbed = ttsRes?.dubbedCount || 0;
                      const primaryProv = ttsRes?.voiceProvider || params.voiceProvider;
                      const isErr = ['failed', 'error', 'timeout'].includes(ttsJob.status);
                      const isRet = ttsJob.retryable === true;
                      return (
                        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Zap className="w-4 h-4 text-emerald-500" />
                              <span className="text-xs font-semibold text-foreground">
                                Lồng tiếng & Tối ưu Cache (TTS)
                              </span>
                            </div>
                            <span className="text-[11px] font-mono text-muted-foreground">
                              {ttsJob.status}
                            </span>
                          </div>
                          <div className="space-y-2 text-xs">
                            <div className="flex justify-between items-center py-1.5 border-b border-border/40">
                              <span className="text-muted-foreground">Nhà cung cấp sử dụng</span>
                              <span className="font-semibold text-foreground">
                                {VOICE_PROVIDER_LABELS[primaryProv] || primaryProv || '—'}
                              </span>
                            </div>
                            <div className="flex justify-between items-center py-1.5 border-b border-border/40">
                              <span className="text-muted-foreground">Tái sử dụng Cache</span>
                              <span className="font-mono text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1">
                                {cacheHits > 0 ? (
                                  <>
                                    <Zap className="w-3 h-3" />
                                    <span>{cacheHits}{dubbed > 0 ? ` / ${dubbed}` : ''} đoạn âm thanh</span>
                                  </>
                                ) : (
                                  <span>0 đoạn (tạo mới)</span>
                                )}
                              </span>
                            </div>
                            {isErr && (
                              <div className="py-1.5 text-destructive text-xs space-y-1">
                                <div className="font-medium" title={ttsJob.error_message}>{friendlyJobError(ttsJob.error_message)}</div>
                                {isRet && (
                                  <span className="inline-block text-[10px] text-amber-700 dark:text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">
                                    Lỗi tạm thời — có thể thử lại
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Bảng thuật ngữ cố định (Glossary) — TransFlow-style terminology */}
                    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <BookOpen className="w-4 h-4 text-primary" />
                          <span className="text-xs font-semibold text-foreground">
                            Bảng thuật ngữ cố định (Glossary)
                          </span>
                        </div>
                        <span className="text-[11px] font-mono text-muted-foreground">
                          {glossaryTerms.length} từ
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        Thuật ngữ sẽ được truyền thẳng vào prompt dịch LLM trong thẻ <code className="text-primary font-mono">&lt;glossary&gt;</code> để đảm bảo dịch đồng nhất và chính xác.
                      </p>

                      {/* Form thêm từ mới */}
                      <form onSubmit={handleAddGlossaryTerm} className="space-y-2 pt-1 border-t border-border/40">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[10px] text-muted-foreground block mb-0.5">Từ gốc (source)</label>
                            <input
                              type="text"
                              value={newSourceTerm}
                              onChange={(e) => setNewSourceTerm(e.target.value)}
                              placeholder="e.g. prompt engineering"
                              disabled={isActive || addingTerm}
                              className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-muted/40 border border-border text-foreground placeholder:text-muted-foreground/50 focus:outline-hidden focus:border-primary"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-muted-foreground block mb-0.5">Dịch thành (target)</label>
                            <input
                              type="text"
                              value={newTargetTerm}
                              onChange={(e) => setNewTargetTerm(e.target.value)}
                              placeholder="e.g. kỹ thuật đặt câu lệnh"
                              disabled={isActive || addingTerm}
                              className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-muted/40 border border-border text-foreground placeholder:text-muted-foreground/50 focus:outline-hidden focus:border-primary"
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={newTermNote}
                            onChange={(e) => setNewTermNote(e.target.value)}
                            placeholder="Ghi chú ngữ cảnh (tuỳ chọn)..."
                            disabled={isActive || addingTerm}
                            className="flex-1 px-2.5 py-1.5 rounded-lg text-xs bg-muted/40 border border-border text-foreground placeholder:text-muted-foreground/50 focus:outline-hidden focus:border-primary"
                          />
                          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground shrink-0 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={newTermCaseSensitive}
                              onChange={(e) => setNewTermCaseSensitive(e.target.checked)}
                              disabled={isActive || addingTerm}
                              className="rounded border-border text-primary focus:ring-primary w-3.5 h-3.5"
                            />
                            <span>Phân biệt hoa/thường</span>
                          </label>
                          <button
                            type="submit"
                            disabled={!newSourceTerm.trim() || !newTargetTerm.trim() || addingTerm || isActive}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors flex items-center gap-1 shrink-0"
                          >
                            {addingTerm ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                            <span>Thêm</span>
                          </button>
                        </div>
                      </form>

                      {/* Danh sách từ đã lưu */}
                      {loadingGlossary ? (
                        <div className="py-3 flex justify-center text-xs text-muted-foreground">
                          <Loader2 className="w-4 h-4 animate-spin mr-2" /> Đang tải thuật ngữ...
                        </div>
                      ) : glossaryTerms.length === 0 ? (
                        <div className="py-2 text-center text-xs text-muted-foreground/70 italic">
                          Chưa có thuật ngữ nào cho dự án này.
                        </div>
                      ) : (
                        <div className="space-y-1.5 max-h-[220px] overflow-y-auto pr-1 pt-1">
                          {glossaryTerms.map((t) => {
                            const isCaseSensitive = Boolean(t.case_sensitive ?? t.caseSensitive);
                            return (
                              <div
                                key={t.id}
                                className="flex items-center justify-between p-2 rounded-lg bg-muted/30 border border-border/50 text-xs hover:border-border transition-colors group"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-semibold text-foreground truncate">{t.source || t.source_term}</span>
                                    <span className="text-muted-foreground">→</span>
                                    <span className="font-semibold text-primary truncate">{t.target || t.target_term}</span>
                                    {isCaseSensitive && (
                                      <span
                                        className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-primary/10 text-primary border border-primary/20 shrink-0"
                                        title="Phân biệt chữ hoa / chữ thường"
                                      >
                                        Aa
                                      </span>
                                    )}
                                  </div>
                                  {t.note && (
                                    <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                                      {t.note}
                                    </div>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setGlossaryDeleteTarget({ id: t.id, label: t.source || t.source_term })}
                                  disabled={isActive}
                                  title="Xoá thuật ngữ"
                                  aria-label={`Xoá thuật ngữ ${t.source || t.source_term}`}
                                  className="opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all shrink-0 ml-2"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 4. Simplified Timeline — F2 Option B (view-only, YAGNI):
              kéo/thả trên timeline chỉ xem thử, không persist (store Zustand local).
              Sửa timing thật ở TranscriptEditor → Lưu (PUT transcript). */}
          <div className="shrink-0">
            <VideoTimeline
              currentTime={currentTime}
              duration={duration}
              isPlaying={isPlaying}
              playbackSpeed={playbackSpeed}
              volume={volume}
              muted={muted}
              onSeek={handleSeek}
              onPlayPause={handlePlayPause}
              onSpeedChange={handleSpeedChange}
              onVolumeChange={handleVolumeChange}
              onMuteToggle={handleMuteToggle}
              onSegmentClick={handleSegmentClick}
              activeSegmentId={activeSegmentId}
              transcript={transcript}
              project={project}
              outputUrl={outputUrl}
              className="rounded-none border-x-0 border-b-0 border-t border-border"
              minimized={timelineMinimized}
              onToggleMinimize={setTimelineMinimized}
              readOnly
            />
          </div>

          <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <AlertDialogContent className="bg-card border-border text-foreground">
              <AlertDialogHeader>
                <AlertDialogTitle className="text-foreground">Xoá dự án này?</AlertDialogTitle>
                <AlertDialogDescription className="text-muted-foreground">
                  Dự án "{project.title}" cùng video nguồn, giọng đọc, phụ đề và video render sẽ bị xoá vĩnh viễn khỏi kho lưu trữ. Hành động này không thể hoàn tác.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="border-border text-foreground hover:bg-muted">
                  Huỷ
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => { e.preventDefault(); handleDelete(); }}
                  disabled={deleting}
                  className="bg-destructive hover:bg-destructive/90 text-destructive-foreground font-semibold"
                >
                  {deleting ? 'Đang xoá...' : 'Xoá vĩnh viễn'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog open={!!glossaryDeleteTarget} onOpenChange={(open) => { if (!open) setGlossaryDeleteTarget(null); }}>
            <AlertDialogContent className="bg-card border-border text-foreground">
              <AlertDialogHeader>
                <AlertDialogTitle className="text-foreground">Xoá thuật ngữ?</AlertDialogTitle>
                <AlertDialogDescription className="text-muted-foreground">
                  Xoá thuật ngữ "{glossaryDeleteTarget?.label || glossaryDeleteTarget?.id}" khỏi glossary của dự án? Hành động này không thể hoàn tác.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="border-border text-foreground hover:bg-muted">
                  Huỷ
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => { e.preventDefault(); handleDeleteGlossaryTerm(); }}
                  disabled={deletingGlossary}
                  className="bg-destructive hover:bg-destructive/90 text-destructive-foreground font-semibold"
                >
                  {deletingGlossary ? 'Đang xoá...' : 'Xoá'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <YoutubePublishDialog
          project={project}
          open={showYoutubeModal}
          onClose={() => setShowYoutubeModal(false)}
          toast={toast}
          onPublished={load}
        />
      </Layout>
    );
  }

  // SUMMARY: Original layout
  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-5xl mx-auto">
        <Link to="/projects" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4 transition">
          <ArrowLeft className="w-4 h-4" /> Quay lại dự án
        </Link>

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-bold text-foreground">{project.title}</h1>
              <StatusBadge status={project.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              {MODE_LABELS[project.mode] || project.mode}
              {project.mode === 'SUMMARY' && project.target_duration_sec && ` • ${project.target_duration_sec}s`}
              {isScript && project.aspect_ratio && ` • ${project.aspect_ratio}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-destructive/30 text-destructive hover:bg-destructive/10 text-sm font-semibold transition">
              <Trash2 className="w-4 h-4" /> Xoá
            </button>
            {canCancel && ( // Group 1: Cancel button
              <button onClick={handleCancel}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-amber-500/30 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 text-sm font-semibold transition">
                <XCircle className="w-4 h-4" /> Huỷ
              </button>
            )}
            {canRegenerate && (
              <button onClick={handleRegenerate} disabled={regenerating}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-primary/30 text-primary hover:bg-primary/10 text-sm font-semibold transition disabled:opacity-50">
                {regenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} Chạy lại
              </button>
            )}
            {outputUrl && (
              <>
                <a href={outputUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold transition">
                  <Play className="w-4 h-4" /> Xem video
                </a>
                <a href={outputUrl} download className="flex items-center gap-2 px-4 py-2 rounded-xl border border-border hover:bg-muted text-foreground text-sm font-semibold transition">
                  <Download className="w-4 h-4" /> Tải về
                </a>
                <button
                  type="button"
                  onClick={() => setShowYoutubeModal(true)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition shadow-xs"
                >
                  <Youtube className="w-4 h-4" /> Xuất bản YouTube
                </button>
              </>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-6 flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}

        {outputStale && !isActive && (
          <div className="mb-6 flex items-center justify-between gap-3 text-xs sm:text-sm text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>Nội dung kịch bản đã được chỉnh sửa. Nhấn <strong>Chạy lại</strong> để kết xuất lại video với các thay đổi mới nhất.</span>
            </div>
            {canRegenerate && (
              <button
                type="button"
                onClick={() => handleRegenerate()}
                disabled={regenerating}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-black font-semibold text-xs transition disabled:opacity-50"
              >
                {regenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                Chạy lại ngay
              </button>
            )}
          </div>
        )}

        {/* Output preview */}
        {outputUrl && isVideoOutput && (
          <div className="rounded-2xl bg-card border border-border p-4 mb-6 shadow-sm space-y-3">
            {project.output?.youtubeUpload && (
              <YoutubeUploadBadge
                youtubeUpload={project.output.youtubeUpload}
                onOpenPublishModal={() => setShowYoutubeModal(true)}
              />
            )}
            <video id="output-video" src={outputUrl} controls className="w-full max-h-[420px] rounded-xl bg-black" />
          </div>
        )}

        {/* Info grid */}
        <InfoGrid project={project} isDub={isDub} params={params} />

        {/* Pipeline progress */}
        <div className="rounded-xl bg-card border border-border p-5 sm:p-6 mb-6 shadow-xs">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm sm:text-base font-semibold text-foreground">Tiến trình Pipeline</h3>
            {isActive && (
              <span className="inline-flex items-center gap-1.5 text-xs text-primary font-semibold">
                <Loader2 className="w-3 h-3 animate-spin" />
                {sseAvailable ? 'Cập nhật real-time (SSE)' : 'Tự động cập nhật'}
              </span>
            )}
          </div>

          {typeof project.progress === 'number' && (
            <div className="mb-5">
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-primary"
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(100, Math.max(0, project.progress))}%` }}
                  transition={{ duration: 0.4 }}
                />
              </div>
              <div className="text-xs font-mono text-muted-foreground mt-1.5 text-right">{project.progress}%</div>
            </div>
          )}

          <div className="space-y-2.5">
            {stages.map((stageKey, i) => {
              const stage = STAGE_LABELS[stageKey];
              const Icon = stageIcons[stageKey] || Circle;
              const job = jobByStage[stageKey];
              const isCurrent = job?.status === 'running';
              // B1: normalize 'success' (legacy) + 'completed' (BE runner) đều lên xanh —
              // khớp PipelineStatus (DUB) và projectStatus.js BE.
              const isDone = isCompletedStatus(job?.status);
              const isError = ['failed', 'error', 'timeout'].includes(job?.status);
              const isRetry = job?.status === 'retry';

              return (
                <motion.div
                  key={stageKey}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className={`flex items-center gap-3.5 p-3 rounded-lg border transition-colors ${
                    isCurrent
                      ? 'bg-primary/10 border-primary/30'
                      : isDone
                      ? 'bg-card border-border/70'
                      : 'bg-muted/30 border-border/50'
                  }`}
                >
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                    isDone ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' :
                    isError ? 'bg-destructive/15 text-destructive' :
                    isRetry ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' :
                    isCurrent ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
                  }`}>
                    {isDone ? <CheckCircle className="w-4 h-4" /> :
                     isError ? <AlertCircle className="w-4 h-4" /> :
                     isRetry ? <Clock className="w-4 h-4" /> :
                     isCurrent ? <Loader2 className="w-4 h-4 animate-spin" /> :
                     <Icon className="w-4 h-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-foreground">{stage?.label || stageKey}</div>
                    {isRetry && job?.next_retry_at && (
                      <div className="text-xs text-amber-700 dark:text-amber-400 font-medium flex items-center gap-1 mt-0.5">
                        <Clock className="w-3 h-3" /> Đang chờ quota hồi phục lúc {new Date(job.next_retry_at).toLocaleTimeString('vi-VN')}
                      </div>
                    )}
                    {job?.error_message && (
                      <div className="text-xs text-destructive truncate mt-0.5 font-medium" title={job.error_message}>
                        {friendlyJobError(job.error_message)}
                      </div>
                    )}
                    {(() => {
                      let cacheHitCount = 0;
                      if (job?.result) {
                        try {
                          const res = typeof job.result === 'string' ? JSON.parse(job.result) : job.result;
                          if (typeof res?.cacheHitCount === 'number') cacheHitCount = res.cacheHitCount;
                        } catch {}
                      }
                      if (cacheHitCount > 0) {
                        return (
                          <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1 mt-0.5 font-mono">
                            <Zap className="w-3 h-3" />
                            <span>Đã tái sử dụng {cacheHitCount} đoạn âm thanh từ cache</span>
                          </div>
                        );
                      }
                      return null;
                    })()}
                    {isError && job?.retryable === true && (
                      <div className="mt-0.5">
                        <span className="text-[10px] text-amber-700 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 font-medium">
                          Lỗi tạm thời — có thể thử lại
                        </span>
                      </div>
                    )}
                    {job && <div className="text-xs text-muted-foreground mt-0.5 font-mono">{formatDate(job.created_date)}{job.attempts > 1 ? ` • ${job.attempts} lần thử` : ''}</div>}
                  </div>
                  {!job && !isCurrent && !isDone && <Circle className="w-4 h-4 text-muted-foreground/30" />}
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* SCRIPT_TO_VIDEO: Phân đoạn kịch bản, ảnh slide và audio preview */}
        {isScript && (
          <ScriptSegmentsShowcase
            segments={project.scriptSegments}
            aspectRatio={project.aspect_ratio}
            projectId={project.id}
            scriptVersion={project.scriptVersion}
            canEdit={!isActive}
            onUpdateSegment={load}
            toast={toast}
          />
        )}

        {/* TRANSLATE_DUB: editor lời thoại song ngữ (sửa được) */}
        {isDub && (
          <TranscriptEditor
            transcript={transcript}
            onSeek={seekTo}
            hasVideo={!!outputUrl}
            onSave={handleSaveTranscript}
            onRedub={handleRedub}
            onRetranslateSegment={handleRetranslateSegment}
            onRedubSegment={handleRedubSegment}
            retranslatingSegmentId={retranslatingSegmentId}
            redubbingSegmentId={redubbingSegmentId}
            saving={savingTranscript}
            redubbing={redubbing}
            disabled={isActive}
            error={transcriptError}
            targetLanguage={targetLanguage}
            onLanguageChange={setTargetLanguage}
          />
        )}

        {/* Timeline preview (SUMMARY) */}
        {timeline.length > 0 && (
          <div className="rounded-2xl bg-card border border-border p-6 mb-6 shadow-sm">
            <h3 className="text-base font-semibold text-foreground">Bản dựng (Timeline)</h3>
            <p className="text-xs text-muted-foreground mt-1 mb-4">Xem trước các clip theo thứ tự AI đã dựng — chỉ xem, dùng &quot;Chạy lại&quot; nếu chưa ưng ý.</p>
            <div className="flex gap-2 overflow-x-auto pb-2">
              {timeline.map((clip, i) => (
                <div key={clip.id || i} className="shrink-0 w-36 rounded-xl border border-border/70 bg-muted/30 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-muted-foreground">#{clip.order_index ?? i + 1}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary uppercase font-medium">{clip.source_type === 'ASSET' ? 'Asset' : 'Scene'}</span>
                  </div>
                  <div className="w-full h-12 rounded-lg bg-primary/10 flex items-center justify-center mb-2">
                    <Film className="w-4 h-4 text-primary" />
                  </div>
                  <div className="text-xs text-foreground font-medium tabular-nums">{fmtSec(clip.in_sec)} → {fmtSec(clip.out_sec)}</div>
                  <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
                    {clip.speed != null && Number(clip.speed) !== 1 && <span>×{clip.speed}</span>}
                    {clip.transition_in && clip.transition_in !== 'none' && (
                      <span className="inline-flex items-center gap-0.5"><Combine className="w-3 h-3" /> {clip.transition_in}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Scenes (SUMMARY) */}
        {scenes.length > 0 && (
          <div className="rounded-2xl bg-card border border-border p-6 shadow-sm">
            <h3 className="text-base font-semibold text-foreground mb-4">Cảnh ({scenes.length})</h3>
            <div className="space-y-3">
              {scenes.map((item, i) => (
                <div key={item.id} className="flex gap-4 p-3 rounded-xl bg-muted/30 border border-border/70">
                  <div className="text-2xl font-bold text-muted-foreground w-8 text-center">{i + 1}</div>
                  <div className="w-20 h-20 rounded-lg bg-muted flex items-center justify-center shrink-0">
                    <FileText className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-foreground line-clamp-2">{item.description}</div>
                    <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                      <span>{item.start_sec}s – {item.end_sec}s</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent className="bg-card border-border text-foreground">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">Xoá dự án này?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              Dự án “{project.title}” cùng video nguồn, giọng đọc, phụ đề và video render sẽ bị xoá vĩnh viễn khỏi kho lưu trữ. Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border text-foreground hover:bg-muted">
              Huỷ
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDelete(); }}
              disabled={deleting}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground font-semibold"
            >
              {deleting ? 'Đang xoá...' : 'Xoá vĩnh viễn'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <YoutubePublishDialog
        project={project}
        open={showYoutubeModal}
        onClose={() => setShowYoutubeModal(false)}
        toast={toast}
        onPublished={load}
      />
    </Layout>
  );
}

function InfoGrid({ project, isDub, params }) {
  const isScript = project?.mode === 'SCRIPT_TO_VIDEO' || project?.mode === 'AI_VIDEO' || project?.mode === 'script_to_video';
  const rows = isDub
    ? [
        ['Chế độ', MODE_LABELS[project.mode] || project.mode],
        ['Ngôn ngữ', `${SOURCE_LANGUAGES[params.sourceLanguage ?? params.source_language] || params.sourceLanguage || 'Tự động'} → ${TARGET_LANGUAGES[params.targetLanguage ?? params.target_language] || project.language || 'vi'}`],
        ['Phong cách dịch', params.stylePreset ?? params.style_preset ?? '—'],
        ['Lồng tiếng AI', (params.enableDubbing ?? params.enable_dubbing) ? `Bật (${VOICE_PROVIDER_LABELS[params.voiceProvider] || params.voiceProvider || 'mặc định'})` : 'Tắt'],
      ]
    : isScript
    ? [
        ['Chế độ', MODE_LABELS[project.mode] || project.mode],
        ['Tỉ lệ khung hình', project.aspect_ratio || '16:9'],
        ['Giọng đọc', VOICE_PROVIDER_LABELS[params.voiceProvider] || params.voiceProvider || 'Edge-TTS'],
        ['Phân đoạn', `${(project.scriptSegments || []).length} đoạn`],
        ['Đóng dấu phụ đề', params.burnSubtitles !== false ? 'Bật (ASS)' : 'Tắt'],
      ]
    : [
        ['Chế độ', MODE_LABELS[project.mode] || project.mode],
        ['Ngôn ngữ', LANGUAGE_LABELS[project.language] || project.language],
        ['Thời lượng', project.target_duration_sec ? `${project.target_duration_sec}s` : '—'],
        ['Phong cách', STYLE_LABELS[project.style] || project.style],
        ['Giọng nói', VOICE_PROVIDER_LABELS[params.voiceProvider] || params.voiceProvider || '—'],
      ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
      {rows.map(([k, v]) => (
        <div key={k} className="rounded-xl bg-card border border-border p-4 shadow-sm">
          <div className="text-xs text-muted-foreground">{k}</div>
          <div className="text-sm font-semibold text-foreground mt-1 truncate" title={String(v)}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function ScriptSegmentsShowcase({ segments, aspectRatio, projectId, scriptVersion, canEdit, onUpdateSegment, toast }) {
  const [editingSegmentId, setEditingSegmentId] = useState(null);
  const [draftNarration, setDraftNarration] = useState('');
  const [draftVisualPrompt, setDraftVisualPrompt] = useState('');
  const [savingId, setSavingId] = useState(null);

  if (!segments || !segments.length) return null;
  const isPortrait = aspectRatio === '9:16';

  const handleStartEdit = (seg) => {
    setEditingSegmentId(seg.id);
    setDraftNarration(seg.narrationText || '');
    setDraftVisualPrompt(seg.visualPrompt || '');
  };

  const handleCancelEdit = () => {
    setEditingSegmentId(null);
    setDraftNarration('');
    setDraftVisualPrompt('');
  };

  const handleSaveSegment = async (seg, idx) => {
    if (!projectId) return;
    setSavingId(seg.id);
    try {
      await projectsApi.updateScriptSegment(projectId, seg.id, {
        scriptVersion,
        narrationText: draftNarration,
        visualPrompt: draftVisualPrompt,
      });
      if (toast) {
        toast({
          title: 'Đã lưu phân đoạn kịch bản',
          description: `Phân đoạn #${idx + 1} đã được cập nhật. Nhấn 'Chạy lại' để kết xuất video mới.`,
        });
      }
      setEditingSegmentId(null);
      if (onUpdateSegment) onUpdateSegment();
    } catch (err) {
      if (toast) {
        toast({
          variant: 'destructive',
          title: 'Lỗi cập nhật phân đoạn',
          description: err?.response?.data?.message || err.message,
        });
      }
    } finally {
      setSavingId(null);
    }
  };

  const handleCopyFullScript = async () => {
    const text = segments
      .map((s, i) => `${i + 1}. ${s.narrationText || ''}`)
      .filter(Boolean)
      .join('\n\n');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      if (toast) {
        toast({
          title: 'Đã sao chép kịch bản',
          description: `Đã sao chép lời thoại của ${segments.length} phân đoạn vào clipboard.`,
        });
      }
    } catch (_) {
      if (toast) {
        toast({
          variant: 'destructive',
          title: 'Không thể sao chép',
          description: 'Trình duyệt chặn truy cập clipboard.',
        });
      }
    }
  };

  return (
    <div className="rounded-2xl bg-card border border-border p-5 sm:p-6 mb-6 shadow-xs">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm sm:text-base font-semibold text-foreground">
            Các phân đoạn kịch bản & Slide trình chiếu
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Danh sách {segments.length} phân đoạn gồm hình ảnh slide, lời thoại và âm thanh giọng đọc AI
          </p>
        </div>
        <button
          type="button"
          onClick={handleCopyFullScript}
          className="self-start sm:self-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border hover:bg-muted text-xs font-semibold text-foreground transition shrink-0"
          title="Sao chép toàn bộ lời thoại kịch bản"
        >
          <Copy className="w-3.5 h-3.5 text-muted-foreground" />
          <span>Sao chép kịch bản</span>
        </button>
      </div>

      <div className="space-y-3.5">
        {segments.map((seg, idx) => {
          const isEditing = editingSegmentId === seg.id;
          return (
            <div
              key={seg.id || idx}
              className={`flex flex-col sm:flex-row gap-4 p-4 rounded-xl border transition-colors ${
                isEditing
                  ? 'bg-muted/50 border-primary/40 shadow-sm'
                  : 'bg-muted/30 border-border/70 hover:border-border'
              }`}
            >
              {/* Cột trái: Thumbnail Slide */}
              <div className={`shrink-0 overflow-hidden rounded-lg bg-black/60 border border-border/80 flex items-center justify-center relative group/slide ${
                isPortrait ? 'w-24 h-40 sm:w-28 sm:h-44' : 'w-full sm:w-48 h-28'
              }`}>
                {seg.imageUrl ? (
                  <>
                    <img
                      src={seg.imageUrl}
                      alt={`Slide ${idx + 1}`}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                    <a
                      href={`${seg.imageUrl}&size=full`}
                      target="_blank"
                      rel="noreferrer"
                      className="absolute bottom-1.5 right-1.5 p-1 rounded-md bg-black/70 hover:bg-black/90 text-white backdrop-blur-xs opacity-0 group-hover/slide:opacity-100 transition-opacity"
                      title="Xem ảnh slide gốc độ phân giải cao"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center gap-1.5 p-3 text-center text-muted-foreground">
                    <Film className="w-5 h-5 text-muted-foreground/60" />
                    <span className="text-[11px] leading-tight">
                      {seg.status === 'image_ready' || seg.status === 'completed'
                        ? 'Slide'
                        : 'Đang tạo slide...'}
                    </span>
                  </div>
                )}
                <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-black/70 text-white backdrop-blur-xs">
                  #{idx + 1}
                </span>
              </div>

              {/* Cột giữa: Lời thoại, Prompt hoặc Form chỉnh sửa */}
              <div className="flex-1 min-w-0 flex flex-col justify-between gap-2.5">
                {isEditing ? (
                  <div className="space-y-3">
                    <div>
                      <label className="text-[11px] font-semibold text-foreground uppercase tracking-wider block mb-1">
                        Lời thoại thuyết minh:
                      </label>
                      <textarea
                        value={draftNarration}
                        onChange={(e) => setDraftNarration(e.target.value)}
                        rows={3}
                        className="w-full text-xs sm:text-sm p-2.5 rounded-lg bg-background border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-primary leading-relaxed"
                        placeholder="Nhập lời thoại của phân đoạn..."
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-semibold text-foreground uppercase tracking-wider block mb-1">
                        Mô tả ảnh slide (Visual Prompt):
                      </label>
                      <input
                        type="text"
                        value={draftVisualPrompt}
                        onChange={(e) => setDraftVisualPrompt(e.target.value)}
                        className="w-full text-xs p-2.5 rounded-lg bg-background border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                        placeholder="Mô tả hình ảnh trực quan cho slide..."
                      />
                    </div>
                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        disabled={savingId === seg.id}
                        className="px-3 py-1.5 rounded-lg border border-border hover:bg-muted text-xs font-medium text-muted-foreground transition"
                      >
                        Hủy
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveSegment(seg, idx)}
                        disabled={savingId === seg.id}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold transition disabled:opacity-50"
                      >
                        {savingId === seg.id ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span>Đang lưu...</span>
                          </>
                        ) : (
                          <>
                            <Save className="w-3.5 h-3.5" />
                            <span>Lưu phân đoạn</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <div className="text-xs sm:text-sm font-medium text-foreground leading-relaxed">
                        {seg.narrationText || '—'}
                      </div>
                      {seg.visualPrompt && (
                        <div className="text-xs text-muted-foreground/90 italic flex items-start gap-1.5">
                          <span className="shrink-0 font-semibold not-italic text-[11px] uppercase tracking-wider text-muted-foreground/70">Mô tả:</span>
                          <span>{seg.visualPrompt}</span>
                        </div>
                      )}
                    </div>

                    {/* Trình phát âm thanh */}
                    {seg.audioUrl ? (
                      <div className="pt-1">
                        <audio
                          src={seg.audioUrl}
                          controls
                          preload="none"
                          className="h-8 w-full max-w-md accent-primary"
                        />
                      </div>
                    ) : (
                      <div className="text-[11px] text-muted-foreground/70 flex items-center gap-1.5 pt-1">
                        <Mic className="w-3.5 h-3.5" />
                        <span>Đang chờ xử lý giọng đọc...</span>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Cột phải: Thời lượng, Trạng thái & Nút sửa */}
              <div className="shrink-0 flex sm:flex-col items-center sm:items-end justify-between sm:justify-start gap-2.5 text-xs font-mono">
                <div className="flex items-center sm:flex-col items-end gap-1.5">
                  <span className="px-2 py-1 rounded-md bg-background border border-border text-foreground font-semibold">
                    {seg.durationSec != null ? `${seg.durationSec}s` : '—'}
                  </span>
                  <span className={`text-[11px] capitalize ${
                    seg.status === 'tts_ready' || seg.status === 'completed' || seg.hasAudio
                      ? 'text-emerald-500'
                      : 'text-muted-foreground'
                  }`}>
                    {seg.status || 'pending'}
                  </span>
                </div>

                {canEdit && !isEditing && (
                  <button
                    type="button"
                    onClick={() => handleStartEdit(seg)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-border hover:border-primary/40 hover:bg-muted text-xs font-medium text-foreground transition"
                    title="Chỉnh sửa lời thoại hoặc mô tả hình ảnh"
                  >
                    <Pencil className="w-3 h-3 text-primary" />
                    <span>Sửa</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function YoutubeUploadBadge({ youtubeUpload, onOpenPublishModal }) {
  if (!youtubeUpload) return null;
  const status = youtubeUpload.status;

  if (status === 'completed') {
    return (
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium">
        <div className="flex items-center gap-2 min-w-0">
          <Youtube className="w-4 h-4 text-red-500 shrink-0" />
          <span className="font-semibold text-foreground">Đã xuất bản lên YouTube</span>
          {youtubeUpload.privacy && (
            <span className="px-1.5 py-0.5 rounded text-[10px] uppercase font-mono tracking-wider bg-red-500/20 text-red-300">
              {youtubeUpload.privacy}
            </span>
          )}
        </div>
        {youtubeUpload.youtubeVideoUrl && (
          <a
            href={youtubeUpload.youtubeVideoUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold text-xs transition shadow-xs"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Xem trên YouTube</span>
            <ExternalLink className="w-3 h-3 opacity-70" />
          </a>
        )}
      </div>
    );
  }

  if (['queued', 'uploading', 'processing'].includes(status)) {
    return (
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-300 text-xs font-medium">
        <div className="flex items-center gap-2.5 min-w-0">
          <Loader2 className="w-4 h-4 animate-spin text-amber-400 shrink-0" />
          <span className="font-semibold">Đang tải lên YouTube...</span>
          {typeof youtubeUpload.progress === 'number' && youtubeUpload.progress > 0 && (
            <span className="font-mono text-[11px] text-amber-400">({youtubeUpload.progress}%)</span>
          )}
        </div>
        <span className="text-[11px] text-amber-400/80 capitalize font-mono shrink-0">
          {status}
        </span>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-xs font-medium">
        <div className="flex items-center gap-2 min-w-0">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="truncate">
            Tải lên YouTube thất bại{youtubeUpload.errorMessage ? `: ${youtubeUpload.errorMessage}` : ''}
          </span>
        </div>
        {onOpenPublishModal && (
          <button
            type="button"
            onClick={onOpenPublishModal}
            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-destructive hover:bg-destructive/90 text-destructive-foreground font-semibold text-xs transition"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Thử lại</span>
          </button>
        )}
      </div>
    );
  }

  return null;
}

function YoutubePublishDialog({ project, open, onClose, toast, onPublished }) {
  const [checking, setChecking] = useState(true);
  const [account, setAccount] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [publishStatus, setPublishStatus] = useState(null);

  useEffect(() => {
    if (!open) {
      setPublishStatus(null);
      return;
    }
    setChecking(true);
    youtubeApi.getAccount()
      .then((acc) => setAccount(acc))
      .catch(() => setAccount({ connected: false }))
      .finally(() => setChecking(false));
  }, [open]);

  if (!open) return null;

  const outputId = project?.output?.id;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!outputId || publishing) return;
    setPublishing(true);
    const fd = new FormData(e.target);
    const title = fd.get('title');
    const description = fd.get('description');
    const tags = fd.get('tags')?.split(',').map((t) => t.trim()).filter(Boolean) || [];
    const privacy = fd.get('privacy') || 'private';

    try {
      await youtubeApi.publishOutput(outputId, {
        title,
        description,
        tags,
        categoryId: '22',
        privacy,
        confirmed: true,
      });
      toast({
        title: 'Đã gửi yêu cầu xuất bản',
        description: 'Video đã được xếp hàng tải lên YouTube.',
      });
      setPublishStatus('queued');
      if (onPublished) onPublished();

      // Poll status
      const deadline = Date.now() + 120000;
      const poll = async () => {
        try {
          const st = await youtubeApi.getPublishStatus(outputId);
          setPublishStatus(st?.status || 'queued');
          if (st?.status === 'completed') {
            toast({
              title: 'Xuất bản thành công!',
              description: st?.youtubeVideoUrl ? `Video đã xuất bản: ${st.youtubeVideoUrl}` : 'Video đã xuất bản lên kênh YouTube của bạn.',
            });
            if (onPublished) onPublished();
            setTimeout(onClose, 2000);
            return;
          }
          if (['failed', 'cancelled'].includes(st?.status)) {
            toast({
              variant: 'destructive',
              title: 'Xuất bản thất bại',
              description: st?.errorMessage || 'Quá trình tải lên YouTube gặp lỗi.',
            });
            if (onPublished) onPublished();
            return;
          }
          if (Date.now() < deadline) setTimeout(poll, 3000);
        } catch (_) {}
      };
      poll();
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Lỗi xuất bản YouTube',
        description: err?.response?.data?.message || err.message,
      });
      setPublishing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in">
      <div className="rounded-2xl bg-card border border-border p-6 max-w-lg w-full shadow-2xl space-y-4">
        <div className="flex items-center justify-between pb-2 border-b border-border/60">
          <div className="flex items-center gap-2 text-foreground font-semibold">
            <Youtube className="w-5 h-5 text-red-600" />
            <span>Xuất bản video lên YouTube</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-sm p-1 rounded-md transition"
          >
            ✕
          </button>
        </div>

        {checking ? (
          <div className="py-8 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
            <span className="text-xs">Đang kiểm tra liên kết tài khoản...</span>
          </div>
        ) : !account?.connected ? (
          <div className="py-4 space-y-4 text-center">
            <div className="w-12 h-12 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div>
              <h4 className="text-sm font-semibold text-foreground">Chưa kết nối kênh YouTube</h4>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                Bạn cần liên kết tài khoản Google có kênh YouTube trước khi có thể xuất bản video.
              </p>
            </div>
            <div className="pt-2 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl border border-border text-xs font-semibold hover:bg-muted transition"
              >
                Đóng
              </button>
              <Link
                to="/settings"
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold transition inline-flex items-center gap-1.5"
              >
                <Youtube className="w-3.5 h-3.5" />
                <span>Đi tới Cài đặt để kết nối</span>
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-muted/40 border border-border/70 text-xs">
              <div className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
              <span className="text-muted-foreground">Kênh đích:</span>
              <strong className="text-foreground truncate">{account.channelTitle || account.channelId || 'Kênh đã kết nối'}</strong>
            </div>

            <div>
              <label className="text-xs font-semibold text-foreground block mb-1">Tiêu đề video</label>
              <input
                type="text"
                name="title"
                required
                maxLength={100}
                defaultValue={project.title || 'Video AI'}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-xs sm:text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-foreground block mb-1">Mô tả video</label>
              <textarea
                name="description"
                rows={3}
                maxLength={5000}
                placeholder="Mô tả nội dung video xuất bản..."
                defaultValue={`Video được tạo tự động bởi Video_AI.\nChế độ: ${MODE_LABELS[project.mode] || project.mode}`}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-xs sm:text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">Tags (phân cách bằng dấu phẩy)</label>
                <input
                  type="text"
                  name="tags"
                  placeholder="video ai, review, thuyết minh"
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">Quyền riêng tư</label>
                <select
                  name="privacy"
                  defaultValue="private"
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="private">Riêng tư (Private)</option>
                  <option value="unlisted">Không công khai (Unlisted)</option>
                  <option value="public">Công khai (Public)</option>
                </select>
              </div>
            </div>

            <div className="flex items-start gap-2 pt-1">
              <input
                type="checkbox"
                name="confirmed"
                id="modal-yt-confirm"
                required
                className="mt-0.5 w-4 h-4 rounded text-primary focus:ring-primary"
              />
              <label htmlFor="modal-yt-confirm" className="text-xs text-muted-foreground cursor-pointer">
                Tôi xác nhận video tuân thủ chính sách bản quyền và nguyên tắc cộng đồng của YouTube.
              </label>
            </div>

            {publishStatus && (
              <div className="p-3 rounded-lg bg-primary/10 border border-primary/20 text-xs flex items-center gap-2 text-primary">
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                <span>Trạng thái xuất bản: <strong className="uppercase font-mono">{publishStatus}</strong></span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/60">
              <button
                type="button"
                onClick={onClose}
                disabled={publishing}
                className="px-4 py-2 rounded-xl border border-border text-xs font-medium hover:bg-muted transition"
              >
                Huỷ
              </button>
              <button
                type="submit"
                disabled={publishing}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold transition flex items-center gap-2 shadow-sm disabled:opacity-50"
              >
                {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Youtube className="w-3.5 h-3.5" />}
                <span>{publishing ? 'Đang gửi...' : 'Xuất bản ngay'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function TranscriptEditor({
  transcript,
  onSeek,
  hasVideo,
  onSave,
  onRedub,
  onRetranslateSegment,
  onRedubSegment,
  retranslatingSegmentId,
  redubbingSegmentId,
  saving,
  redubbing,
  disabled,
  error,
  compact = false,
  targetLanguage = 'vi',
  onLanguageChange,
  activeSegmentId = null,
  qaByIndex = new Map(),
}) {
  // §7: chỉnh trực tiếp Original / Translation / Start / End. Không drag-and-drop.
  // edits: { [segmentId]: { text?, translation?, startSec?, endSec? } }
  const [edits, setEdits] = useState({});
  const savingRef = useRef(false);
  const [localError, setLocalError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState('all'); // 'all' | 'dirty' | 'untranslated' | 'cached' | 'repaired' | 'warning' | 'qa'
  const [autoScroll, setAutoScroll] = useState(true);

  const getField = (seg, field) => (edits[seg.id]?.[field] !== undefined ? edits[seg.id][field] : seg[field]);
  const isDirtyRow = (s) => {
    const e = edits[s.id];
    if (!e) return false;
    return ['text', 'translation', 'startSec', 'endSec'].some((f) => e[f] !== undefined && e[f] !== s[f]);
  };
  const dirtyCount = transcript.filter(isDirtyRow).length;
  const translatedCount = transcript.filter((s) => String(getField(s, 'translation') || '').trim()).length;
  const untranslatedCount = transcript.length - translatedCount;
  const qaCount = transcript.filter((s) => (qaByIndex.get(Number(s.index)) || []).length > 0).length;
  const cachedCount = transcript.filter((s) => Boolean(s.cached)).length;
  const repairedCount = transcript.filter((s) => Boolean(s.repaired)).length;
  const warningCount = transcript.filter((s) => Boolean(s.warning)).length;

  const setField = (seg, field, value) => {
    setLocalError('');
    setEdits((p) => ({ ...p, [seg.id]: { ...p[seg.id], [field]: value } }));
  };

  // Auto-scroll to active segment
  useEffect(() => {
    if (!autoScroll || !activeSegmentId) return;
    const el = document.getElementById(`seg-${activeSegmentId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeSegmentId, autoScroll]);

  // Validation client: 0 <= start < end + không overlap câu trước/sau.
  // Server (OVERLAP_CONFLICT) là authority cuối; đây chỉ là pre-check nhanh.
  // Chỉ kiểm tra timing nếu người dùng thực sự sửa timing ở câu đó, tránh chặn việc sửa dịch thuần túy.
  const validatePayload = (payload) => {
    const byId = new Map(transcript.map((s) => [s.id, s]));
    const eff = (s) => {
      const p = payload.find((x) => x.id === s.id);
      return {
        startSec: p?.startSec !== undefined ? Number(p.startSec) : Number(s.startSec),
        endSec: p?.endSec !== undefined ? Number(p.endSec) : Number(s.endSec),
      };
    };
    const sorted = [...transcript].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const p of payload) {
      const s = byId.get(p.id);
      if (!s) continue;
      const isTimingEdited = p.startSec !== undefined || p.endSec !== undefined;
      if (isTimingEdited) {
        const { startSec, endSec } = eff(s);
        if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || !(startSec >= 0) || !(endSec > startSec)) {
          return `Câu #${(s.index ?? 0) + 1}: timing không hợp lệ (cần 0 ≤ start < end).`;
        }
        const i = sorted.findIndex((x) => x.id === s.id);
        if (i > 0 && startSec < Number(eff(sorted[i - 1]).endSec)) {
          return `Câu #${(s.index ?? 0) + 1}: start (${startSec}s) overlap câu trước (kết thúc ${eff(sorted[i - 1]).endSec}s).`;
        }
        if (i < sorted.length - 1 && endSec > Number(eff(sorted[i + 1]).startSec)) {
          return `Câu #${(s.index ?? 0) + 1}: end (${endSec}s) overlap câu sau (bắt đầu ${eff(sorted[i + 1]).startSec}s).`;
        }
      }
    }
    return '';
  };

  const changedPayload = () =>
    transcript
      .filter(isDirtyRow)
      .map((s) => {
        const e = edits[s.id];
        const out = { id: s.id };
        for (const f of ['text', 'translation', 'startSec', 'endSec']) {
          if (e[f] !== undefined && e[f] !== s[f]) out[f] = e[f];
        }
        return out;
      });

  const handleSave = async () => {
    if (savingRef.current) return; // chống double-click → stale response
    const payload = changedPayload();
    if (!payload.length) return;
    const err = validatePayload(payload);
    if (err) {
      setLocalError(err);
      return;
    }
    savingRef.current = true;
    try {
      const result = await onSave(payload);
      if (result === null) {
        // conflict/stale: edits được giữ, thông báo đã hiển thị ở onSave
        return;
      }
      const savedIds = new Set(payload.map((p) => p.id));
      setEdits((prev) => {
        const next = { ...prev };
        let changed = false;
        savedIds.forEach((id) => {
          if (id in next) {
            delete next[id];
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    } finally {
      savingRef.current = false;
    }
  };

  const handleRedub = async () => {
    const payload = changedPayload();
    if (payload.length) {
      const err = validatePayload(payload);
      if (err) {
        setLocalError(err);
        return;
      }
      const saved = await onSave(payload);
      if (saved === null) return;
    }
    // Kiểm tra có ít nhất 1 câu đã dịch để thực hiện lồng tiếng
    const hasAnyTranslation = transcript.some((s) => {
      const val = getField(s, 'translation');
      return String(val || '').trim().length > 0;
    });
    if (!hasAnyTranslation) {
      setLocalError('Chưa có câu nào có bản dịch. Vui lòng nhập bản dịch trước khi lồng tiếng.');
      return;
    }
    setEdits({});
    setLocalError('');
    await onRedub();
  };

  const filteredTranscript = useMemo(() => {
    return transcript.filter((seg) => {
      if (filter === 'dirty' && !isDirtyRow(seg)) return false;
      if (filter === 'untranslated' && String(getField(seg, 'translation') || '').trim().length > 0) return false;
      if (filter === 'qa' && !((qaByIndex.get(Number(seg.index)) || []).length > 0)) return false;
      if (filter === 'cached' && !seg.cached) return false;
      if (filter === 'repaired' && !seg.repaired) return false;
      if (filter === 'warning' && !seg.warning) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const orig = String(getField(seg, 'text') || '').toLowerCase();
        const trans = String(getField(seg, 'translation') || '').toLowerCase();
        const spk = String(seg.speaker || '').toLowerCase();
        if (!orig.includes(q) && !trans.includes(q) && !spk.includes(q)) return false;
      }
      return true;
    });
  }, [transcript, filter, searchQuery, edits, qaByIndex]);

  if (!transcript.length) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center bg-card">
        <Languages className="w-10 h-10 text-muted-foreground/40 mb-3" />
        <h3 className="text-sm font-semibold text-foreground">Chưa có lời thoại</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          Pipeline đang xử lý hoặc chưa được khởi chạy. Lời thoại sẽ tự động xuất hiện tại đây khi nhận dạng xong.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-card">
      {/* 1. Header Toolbar */}
      <div className="shrink-0 p-3.5 border-b border-border bg-card space-y-2.5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-bold text-foreground">Lời thoại song ngữ</h3>
            <span className="text-[11px] font-mono bg-muted px-2 py-0.5 rounded text-muted-foreground">
              {translatedCount}/{transcript.length} đã dịch
            </span>
            {dirtyCount > 0 && (
              <span className="text-[11px] font-semibold bg-amber-500/15 text-amber-800 dark:text-amber-300 px-2 py-0.5 rounded">
                {dirtyCount} chưa lưu
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Language Selector — F9 display-only: chỉ đổi state hiển thị local,
                KHÔNG persist (BE PUT transcript không nhận field `language`). */}
            <div
              className="flex items-center gap-1 bg-background border border-input rounded-lg px-2 py-1"
              title="Hiển thị ngôn ngữ đích — không lưu server (display-only)"
            >
              <Languages className="w-3.5 h-3.5 text-muted-foreground" />
              <select
                value={targetLanguage}
                onChange={(e) => onLanguageChange?.(e.target.value)}
                disabled={disabled}
                title="Hiển thị ngôn ngữ đích — không lưu server (display-only)"
                className="bg-transparent text-xs text-foreground focus:outline-none disabled:opacity-60 font-medium"
              >
                <option value="vi">Tiếng Việt</option>
                <option value="en">Tiếng Anh</option>
                <option value="ja">Tiếng Nhật</option>
                <option value="ko">Tiếng Hàn</option>
                <option value="zh">Tiếng Trung</option>
              </select>
            </div>
            {/* Save Button */}
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || disabled || dirtyCount === 0}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-emerald-500/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 text-xs font-semibold transition disabled:opacity-40"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
              <span>Lưu{dirtyCount > 0 ? ` (${dirtyCount})` : ''}</span>
            </button>
            {/* Redub Button */}
            <button
              type="button"
              onClick={handleRedub}
              disabled={redubbing || disabled}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-primary/30 text-primary hover:bg-primary/10 text-xs font-semibold transition disabled:opacity-40"
            >
              {redubbing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AudioLines className="w-3.5 h-3.5" />}
              <span>Lồng tiếng lại</span>
            </button>
          </div>
        </div>

        {/* Search & Filter Toolbar */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[150px]">
            <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm kiếm lời thoại gốc hoặc dịch..."
              className="w-full pl-8 pr-7 py-1 text-xs rounded-lg bg-background border border-input text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
              >
                ✕
              </button>
            )}
          </div>

          {/* Filter Pills */}
          <div className="flex items-center gap-1 bg-muted/60 p-0.5 rounded-lg text-[11px] flex-wrap">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`px-2 py-0.5 rounded font-medium transition ${
                filter === 'all' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Tất cả ({transcript.length})
            </button>
            <button
              type="button"
              onClick={() => setFilter('dirty')}
              className={`px-2 py-0.5 rounded font-medium transition ${
                filter === 'dirty' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Đã sửa ({dirtyCount})
            </button>
            <button
              type="button"
              onClick={() => setFilter('untranslated')}
              className={`px-2 py-0.5 rounded font-medium transition ${
                filter === 'untranslated' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Chưa dịch ({untranslatedCount})
            </button>
            {cachedCount > 0 && (
              <button
                type="button"
                onClick={() => setFilter('cached')}
                className={`px-2 py-0.5 rounded font-medium transition flex items-center gap-1 ${
                  filter === 'cached' ? 'bg-background text-emerald-700 dark:text-emerald-300 shadow-xs' : 'text-emerald-600/80 hover:text-emerald-600'
                }`}
              >
                <Zap className="w-3 h-3" />
                <span>Cache ({cachedCount})</span>
              </button>
            )}
            {repairedCount > 0 && (
              <button
                type="button"
                onClick={() => setFilter('repaired')}
                className={`px-2 py-0.5 rounded font-medium transition flex items-center gap-1 ${
                  filter === 'repaired' ? 'bg-background text-purple-700 dark:text-purple-300 shadow-xs' : 'text-purple-600/80 hover:text-purple-600'
                }`}
              >
                <Sparkles className="w-3 h-3" />
                <span>Đã sửa ({repairedCount})</span>
              </button>
            )}
            {warningCount > 0 && (
              <button
                type="button"
                onClick={() => setFilter('warning')}
                className={`px-2 py-0.5 rounded font-medium transition flex items-center gap-1 ${
                  filter === 'warning' ? 'bg-background text-amber-700 dark:text-amber-300 shadow-xs' : 'text-amber-600/80 hover:text-amber-600'
                }`}
              >
                <AlertTriangle className="w-3 h-3" />
                <span>Cần xem ({warningCount})</span>
              </button>
            )}
            {qaCount > 0 && (
              <button
                type="button"
                onClick={() => setFilter('qa')}
                title="Câu bị QA gắn cờ — sửa tay rồi Chạy lại từ dub.translate"
                className={`px-2 py-0.5 rounded font-medium transition ${
                  filter === 'qa' ? 'bg-background text-foreground shadow-xs' : 'text-rose-600 dark:text-rose-300 hover:text-foreground'
                }`}
              >
                Lỗi QA ({qaCount})
              </button>
            )}
          </div>

          {/* Auto-scroll toggle */}
          <button
            type="button"
            onClick={() => setAutoScroll(!autoScroll)}
            title={autoScroll ? 'Đang bật tự cuộn theo video (nhấn để tắt)' : 'Đang tắt tự cuộn (nhấn để bật)'}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium border transition ${
              autoScroll
                ? 'bg-primary/10 border-primary/30 text-primary'
                : 'bg-background border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            <ArrowDownToLine className="w-3 h-3" />
            <span className="hidden sm:inline">Tự cuộn</span>
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
          </div>
        )}
        {localError && (
          <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {localError}
          </div>
        )}
      </div>

      {/* 2. Transcript List */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {filteredTranscript.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            Không tìm thấy câu thoại nào phù hợp với bộ lọc.
          </div>
        ) : (
          filteredTranscript.map((seg, i) => (
            <SegmentCard
              key={seg.id || i}
              seg={seg}
              isDirty={isDirtyRow(seg)}
              isActive={String(seg.id) === String(activeSegmentId) || Number(seg.index) === Number(activeSegmentId)}
              getField={getField}
              onField={setField}
              onSeek={onSeek}
              hasVideo={hasVideo}
              disabled={disabled}
              qaIssues={qaByIndex.get(Number(seg.index)) || []}
              onRetranslateSegment={onRetranslateSegment}
              onRedubSegment={onRedubSegment}
              isRetranslating={retranslatingSegmentId === seg.id}
              isRedubbing={redubbingSegmentId === seg.id}
            />
          ))
        )}
      </div>
    </div>
  );
}

// §7: thẻ subtitle chỉnh trực tiếp 4 trường (Original / Translation / Start / End).
// Không kéo-thả, không draggable/dataTransfer.
function SegmentCard({
  seg,
  isDirty,
  isActive,
  getField,
  onField,
  onSeek,
  hasVideo,
  disabled,
  qaIssues = [],
  onRetranslateSegment,
  onRedubSegment,
  isRetranslating = false,
  isRedubbing = false,
}) {
  const numCls = 'w-full bg-background border border-input rounded-md px-2 py-1 text-xs text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60 font-mono';
  const areaCls = 'w-full resize-y rounded-md bg-background border border-input px-3 py-1.5 text-xs text-foreground leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60';

  const startVal = Number(getField(seg, 'startSec') ?? 0);
  const endVal = Number(getField(seg, 'endSec') ?? 0);
  const duration = Math.max(0, endVal - startVal).toFixed(1);

  const isProcessing = Boolean(seg.processing || seg.status === 'processing' || isRetranslating || isRedubbing);
  const hasError = Boolean(seg.error || seg.status === 'error');

  return (
    <div
      id={`seg-${seg.id || seg.index}`}
      className={`p-3 rounded-xl border transition-all text-xs ${
        isActive
          ? 'border-primary ring-2 ring-primary/40 bg-primary/[0.04] shadow-xs'
          : isDirty
          ? 'bg-amber-500/5 border-amber-500/30'
          : 'bg-card border-border hover:border-border/90'
      }`}
    >
      {/* Top Header of Card */}
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono font-bold text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            #{(seg.index ?? 0) + 1}
          </span>
          <button
            type="button"
            onClick={() => onSeek(startVal)}
            disabled={!hasVideo}
            title="Nhảy tới mốc thời gian này trên video"
            className="text-xs font-semibold text-muted-foreground hover:text-primary transition-colors disabled:cursor-default tabular-nums font-mono inline-flex items-center gap-1.5 bg-muted/40 hover:bg-primary/10 px-2 py-0.5 rounded"
          >
            <Play className="w-2.5 h-2.5 fill-current" />
            <span>{fmtSec(startVal)}</span>
            <span>→</span>
            <span>{fmtSec(endVal)}</span>
          </button>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {isActive && (
            <span className="text-[10px] px-2 py-0.5 rounded font-semibold bg-primary/15 text-primary flex items-center gap-1">
              <Volume2 className="w-2.5 h-2.5 animate-pulse" /> Đang phát
            </span>
          )}
          {isProcessing && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-blue-500/15 text-blue-700 dark:text-blue-300 border border-blue-500/25 flex items-center gap-1">
              <Loader2 className="w-2.5 h-2.5 animate-spin" /> Đang xử lý
            </span>
          )}
          {seg.cached && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25 flex items-center gap-1"
              title="Tái sử dụng artifact âm thanh từ cache (tiết kiệm quota)"
            >
              <Zap className="w-2.5 h-2.5 fill-current" />
              <span>Cached</span>
            </span>
          )}
          {seg.repaired && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-purple-500/15 text-purple-700 dark:text-purple-300 border border-purple-500/25 flex items-center gap-1"
              title="Bản dịch đã được chỉnh sửa hoặc tối ưu hóa ngữ nghĩa"
            >
              <Sparkles className="w-2.5 h-2.5" />
              <span>Đã sửa ngữ nghĩa</span>
            </span>
          )}
          {seg.warning && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/25 flex items-center gap-1"
              title="Cần xem xét tính nhất quán số liệu / thuật ngữ / thời lượng"
            >
              <AlertTriangle className="w-2.5 h-2.5" />
              <span>Lưu ý</span>
            </span>
          )}
          {hasError && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/25 flex items-center gap-1"
              title={seg.error || 'Có lỗi trong xử lý đoạn này'}
            >
              <AlertCircle className="w-2.5 h-2.5" />
              <span>Lỗi</span>
            </span>
          )}
          {seg.speaker && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-secondary text-secondary-foreground">
              {seg.speaker}
            </span>
          )}
          {isDirty && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-amber-500/15 text-amber-800 dark:text-amber-300">
              đã sửa
            </span>
          )}
          {(qaIssues || []).length > 0 && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-rose-500/15 text-rose-700 dark:text-rose-300"
              title={(qaIssues || []).map((q) => `[${q.severity || ''}/${q.type || ''}] ${q.message || ''}${q.suggestion ? ` → Gợi ý: ${q.suggestion}` : ''}`).join('\n')}
            >
              QA ({qaIssues.length})
            </span>
          )}
        </div>
      </div>

      {/* Content Fields */}
      <div className="space-y-2">
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Gốc (STT)</span>
          </div>
          <textarea
            value={getField(seg, 'text') ?? ''}
            onChange={(e) => onField(seg, 'text', e.target.value)}
            disabled={disabled}
            rows={2}
            placeholder="Lời thoại gốc..."
            className={areaCls}
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-semibold text-primary uppercase tracking-wide">Bản dịch</span>
          </div>
          <textarea
            value={getField(seg, 'translation') ?? ''}
            onChange={(e) => onField(seg, 'translation', e.target.value)}
            disabled={disabled}
            rows={2}
            placeholder="Bản dịch tiếng Việt (sửa tay được giữ nguyên khi chạy lại)..."
            className={areaCls}
          />

          {/* Selective Re-run Actions */}
          <div className="flex items-center justify-end gap-1.5 pt-1.5">
            {onRetranslateSegment && (
              <button
                type="button"
                onClick={() => onRetranslateSegment(seg)}
                disabled={disabled || isRetranslating || isRedubbing}
                title="Dịch lại riêng câu này bằng AI mà không cần chạy lại toàn bộ video"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium border border-border bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground transition disabled:opacity-40"
              >
                {isRetranslating ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin text-primary" />
                    <span>Đang dịch lại...</span>
                  </>
                ) : (
                  <>
                    <Languages className="w-3 h-3 text-primary" />
                    <span>Dịch lại câu này</span>
                  </>
                )}
              </button>
            )}
            {onRedubSegment && (
              <button
                type="button"
                onClick={() => onRedubSegment(seg)}
                disabled={disabled || isRetranslating || isRedubbing || !String(getField(seg, 'translation') || '').trim()}
                title="Thu âm (TTS) lại chỉ riêng câu này và ghép lại âm thanh"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium border border-border bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground transition disabled:opacity-40"
              >
                {isRedubbing ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin text-primary" />
                    <span>Đang thu âm...</span>
                  </>
                ) : (
                  <>
                    <AudioLines className="w-3 h-3 text-primary" />
                    <span>Thu âm lại câu này</span>
                  </>
                )}
              </button>
            )}
          </div>

          {(qaIssues || []).length > 0 && (
            <div className="mt-1.5 space-y-1">
              {qaIssues.map((q, qIdx) => (
                <div
                  key={qIdx}
                  className="flex items-start gap-1.5 p-1.5 rounded-lg bg-rose-500/10 border border-rose-500/25 text-[11px] text-rose-700 dark:text-rose-300 leading-normal"
                >
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-rose-500" />
                  <div className="flex-1 min-w-0">
                    <span className="font-semibold">
                      {q.type === 'tts' ? '[Lồng tiếng]' : q.type === 'gate' ? '[Kiểm định]' : '[QA]'}:{' '}
                    </span>
                    <span>{q.message}</span>
                    {q.suggestion && (
                      <span className="block italic text-muted-foreground mt-0.5">Gợi ý: {q.suggestion}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Timing Controls */}
      <div className="flex items-center gap-3 mt-2.5 pt-2 border-t border-border/50 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1.5 flex-1">
          <span className="font-medium shrink-0">Bắt đầu:</span>
          <input
            type="number" step={0.1} min={0}
            value={getField(seg, 'startSec') ?? 0}
            onChange={(e) => onField(seg, 'startSec', Number(e.target.value))}
            disabled={disabled}
            className={numCls}
          />
          <span className="text-[10px] text-muted-foreground">s</span>
        </div>
        <div className="flex items-center gap-1.5 flex-1">
          <span className="font-medium shrink-0">Kết thúc:</span>
          <input
            type="number" step={0.1} min={0}
            value={getField(seg, 'endSec') ?? 0}
            onChange={(e) => onField(seg, 'endSec', Number(e.target.value))}
            disabled={disabled}
            className={numCls}
          />
          <span className="text-[10px] text-muted-foreground">s</span>
        </div>
        <div className="text-[10px] font-mono text-muted-foreground shrink-0 bg-muted/60 px-2 py-1 rounded">
          {duration}s
        </div>
      </div>
    </div>
  );
}
