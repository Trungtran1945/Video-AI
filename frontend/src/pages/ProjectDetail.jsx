import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { projectsApi } from '@/api/projects';
import Layout from '@/components/Layout';
import Loading from '@/components/Loading';
import { VideoTimeline } from '@/components/timeline';
import MaskEditor from '@/components/MaskEditor';
import { useTimelineStore } from '@/components/timeline';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, FileText, Video, Mic, Captions, CheckCircle, Loader2, Circle, AlertCircle, Play, Pause, Download, RotateCcw, Scissors, Sparkles, Combine, Film, Trash2, FileAudio, Languages, AudioLines, XCircle, Clock } from 'lucide-react';
import { STAGE_LABELS, StatusBadge, formatDate, LANGUAGE_LABELS, STYLE_LABELS, VOICE_PROVIDER_LABELS, MODE_LABELS, SOURCE_LANGUAGES, TARGET_LANGUAGES } from '@/lib/constants';
import { useJobEvents } from '@/hooks/useJobEvents';
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
  'dub.ocr': FileText,
  'dub.stt': Mic,
  'dub.translate': Languages,
  'dub.ttsAlign': AudioLines,
  'dub.render': Video,
};

const SUMMARY_STAGES = ['summary.transcribe', 'summary.sceneDetect', 'summary.analyze', 'summary.script', 'summary.align', 'summary.tts', 'summary.subtitle', 'summary.render'];

const DUB_STAGES_ALL = ['dub.ingest', 'dub.ocr', 'dub.stt', 'dub.translate', 'dub.ttsAlign', 'dub.render'];

const ACTIVE_STATUSES = ['pending', 'queued', 'generating', 'running'];

const POLL_INTERVAL_MS = 3000;

function fmtSec(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function normSegment(s) {
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
  };
}

export default function ProjectDetail() {
  const { id } = useParams();
  const [project, setProject] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [scenes, setScenes] = useState([]);
  const [transcript, setTranscript] = useState([]);
  const [savingTranscript, setSavingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState('');
  const [redubbing, setRedubbing] = useState(false);
  const [outputStale, setOutputStale] = useState(false);
  const [loading, setLoading] = useState(true);
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
  const videoRef = useRef(null);
  // Optimistic concurrency (§4.6): revision server cấp, seq chống stale response.
  const transcriptRevisionRef = useRef(null);
  const transcriptSaveSeqRef = useRef(0);
  const transcriptLoadSeqRef = useRef(0);
  const transcriptSaveInFlightRef = useRef(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  // Zustand store setter for smooth playhead sync
  const setStoreCurrentTime = useTimelineStore((s) => s.setCurrentTime);

  // SSE realtime (best-effort) + DB polling là authoritative fallback.
  // useJobEvents dùng ticket single-use, done không tự suy diễn completed.
  const { events: sseEvents, sseAvailable, lastEvent, streamClosed } = useJobEvents(id, !!project && ACTIVE_STATUSES.includes(project?.status));

  const isDub = project?.mode === 'TRANSLATE_DUB' || project?.mode === 'translate_dub';
  // §1: output chỉ available khi pipeline COMPLETED + output success + artifact hợp lệ.
  // Lúc pending/queued/running/generating (hoặc failed) KHÔNG hiển thị output cũ.
  const isOutputAvailable =
    project?.status === 'completed' &&
    !!project?.output?.storage_key &&
    !outputStale &&
    project?.outputStale !== true &&
    (project?.output?.status === 'success' || !project?.output?.status);
  const outputUrl = isOutputAvailable ? `/storage/${project.output.storage_key}?v=${project.output.id}` : null;
  const isVideoOutput = /\.(mp4|webm|mov|m4v|mkv)$/i.test(project?.output?.storage_key || '');
  // Preview che chữ dùng video NGUỒN để thấy hardsub gốc (output đã blur + sub dịch).
  const sourceUrl = project?.source_video_key ? `/storage/${project.source_video_key}` : outputUrl;

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

  const load = useCallback(async () => {
    try {
      const p = await projectsApi.get(id);
       if (p?.outputStale !== undefined) setOutputStale(p.outputStale === true);
       setProject(p);
      setJobs(p.jobs || []);
      setScenes(p.mode === 'SUMMARY' ? (p.scenes || []) : []);
      return p;
    } catch (e) {
      console.error(e);
      return null;
    }
  }, [id]);

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

  // Poll progress while pipeline is active — chỉ khi SSE không khả dụng (fallback)
  useEffect(() => {
    if (!project || !ACTIVE_STATUSES.includes(project.status)) return undefined;
    if (sseAvailable) return undefined;
    const t = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [project?.status, project, load, sseAvailable]);

  // Khi pipeline vừa chuyển sang completed/failed (sau Chạy lại / Chạy lại lồng tiếng),
  // reload để làm mới output video & trạng thái.
  const prevStatus = useRef(project?.status);
  useEffect(() => {
    if (prevStatus.current && prevStatus.current !== project?.status) {
      if (['completed', 'failed'].includes(project?.status)) load();
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
    if (project && ACTIVE_STATUSES.includes(project.status)) terminalReloadRef.current = 0;
  }, [project?.status]);
  useEffect(() => {
    if (!lastEvent || lastEvent.stage !== '__project__') return undefined;
    if (!['completed', 'failed'].includes(lastEvent.status)) return undefined;
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
      const settled = p && ['completed', 'failed'].includes(p.status);
      if (!cancelled && !settled && attempts < 3) {
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

  const isActive = project && ACTIVE_STATUSES.includes(project.status);
  const canRegenerate = project && ['completed', 'failed'].includes(project.status);
  const canCancel = project && ['running', 'queued', 'pending'].includes(project.status); // Group 1: Cancel

  const handleRegenerate = async () => {
    if (regenerating) return;
    setRegenerating(true);
    setError('');
    try {
      await projectsApi.regenerate(id);
      await load();
    } catch (e) {
      setError('Không thể chạy lại pipeline: ' + (e?.response?.data?.message || e.message));
    } finally {
      setRegenerating(false);
    }
  };

  const handleCancel = async () => { // Group 1: Cancel handler
    try {
      await projectsApi.cancel(id);
      await load();
    } catch (e) {
      setError('Không thể huỷ project: ' + (e?.response?.data?.message || e.message));
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

  const handleSaveTranscript = async (edits) => {
    if (savingTranscript) return null;
    if (!Number.isInteger(transcriptRevisionRef.current)) {
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
    const sentRevision = transcriptRevisionRef.current;
    try {
      const res = await projectsApi.updateTranscript(id, edits, sentRevision);
      // Stale response — bỏ qua, giữ state của request mới nhất.
      if (seq !== transcriptSaveSeqRef.current) return null;
      if (res?.revision !== undefined && res?.revision !== null && Number.isInteger(Number(res.revision))) {
        transcriptRevisionRef.current = Number(res.revision);
      }
      if (Array.isArray(res.segments)) {
        setTranscript(res.segments.map(normSegment));
      }
       if (res?.outputStale !== undefined) setOutputStale(res.outputStale === true);
      toast({ title: 'Đã lưu chỉnh sửa', description: `${res.updated || edits.length} câu đã cập nhật.` });
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
      setTranscriptError('Chưa lưu được: ' + (e?.response?.data?.message || e.message));
      return null;
    } finally {
      if (seq === transcriptSaveSeqRef.current) {
        transcriptSaveInFlightRef.current = false;
        setSavingTranscript(false);
      }
    }
  };

  const handleRedub = async () => {
    if (redubbing) return;
    setRedubbing(true);
    setTranscriptError('');
    try {
      await projectsApi.redub(id);
      toast({ title: 'Đang lồng tiếng lại', description: 'Video sẽ được cập nhật sau khi hoàn tất.' });
      await load();
    } catch (e) {
      setTranscriptError('Không thể chạy lại: ' + (e?.response?.data?.message || e.message));
    } finally {
      setRedubbing(false);
    }
  };

  // Sync targetLanguage from project params once loaded
  useEffect(() => {
    if (project?.params) {
      const lang = project.params.targetLanguage ?? project.params.target_language;
      if (lang) setTargetLanguage(lang);
    }
  }, [project?.params]);

  if (loading) return <Layout><Loading /></Layout>;
  if (!project) return <Layout><div className="p-8 text-center text-slate-400">Không tìm thấy dự án.</div></Layout>;

  // Gộp trạng thái job từ polling + SSE realtime
  const jobByStage = {};
  (jobs || []).forEach((j) => {
    if (!jobByStage[j.type]) jobByStage[j.type] = j;
  });
  Object.entries(sseEvents).forEach(([stage, ev]) => {
    jobByStage[stage] = jobByStage[stage]
      ? { ...jobByStage[stage], status: ev.status || jobByStage[stage].status }
      : { type: stage, status: ev.status };
  });

  const params = project.params || {};
  const enableDubbing = params.enableDubbing ?? params.enable_dubbing ?? false;
  const transcriptStage = params.ocrMode ? 'dub.ocr' : 'dub.stt';
  const stages = isDub
    ? DUB_STAGES_ALL.filter((s) => {
      if (s === 'dub.ttsAlign' && !enableDubbing) return false;
      if (s === 'dub.ocr' || s === 'dub.stt') return s === transcriptStage;
      return true;
    })
    : SUMMARY_STAGES;
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

  // TRANSLATE_DUB: Subtitle sync editor layout
  if (isDub) {
    return (
      <Layout>
        <div className="h-screen flex flex-col bg-background text-foreground">
          {/* 1. Header */}
          <div className="shrink-0 px-4 py-3 border-b border-border bg-card">
            <Link to="/projects" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-2 transition">
              <ArrowLeft className="w-3 h-3" /> Quay lại dự án
            </Link>
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <h1 className="text-lg font-bold text-foreground truncate">{project.title}</h1>
                <StatusBadge status={project.status} />
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Xoá
                </button>
                {canCancel && (
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/30 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                  >
                    <XCircle className="w-3.5 h-3.5" /> Huỷ
                  </button>
                )}
                {canRegenerate && (
                  <button
                    type="button"
                    onClick={handleRegenerate}
                    disabled={regenerating}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/30 text-primary hover:bg-primary/10 text-xs font-semibold transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    {regenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Chạy lại
                  </button>
                )}
                {outputUrl && (
                  <>
                    <a
                      href={outputUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold transition shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Play className="w-3.5 h-3.5" /> Xem
                    </a>
                    <a
                      href={outputUrl}
                      download
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border hover:bg-muted text-foreground text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Download className="w-3.5 h-3.5" /> Tải
                    </a>
                  </>
                )}
              </div>
            </div>
            {error && (
              <div className="mt-2.5 flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
              </div>
            )}
          </div>

          {/* 2. Pipeline Progress - Full width near top */}
          <div className="shrink-0 px-4 py-2.5 bg-card border-b border-border">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] font-bold text-foreground">Pipeline</span>
                {isActive && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-primary font-semibold">
                    <Loader2 className="w-2.5 h-2.5 animate-spin" /> {sseAvailable ? 'SSE' : 'Polling'}
                  </span>
                )}
              </div>
              {typeof project.progress === 'number' && (
                <div className="flex-1 max-w-xs">
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <motion.div
                      className="h-full rounded-full bg-primary"
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.min(100, Math.max(0, project.progress))}%` }}
                      transition={{ duration: 0.4 }}
                    />
                  </div>
                </div>
              )}
              <div className="flex-1 flex flex-wrap gap-1.5">
                {stages.map((stageKey) => {
                  const stage = STAGE_LABELS[stageKey];
                  const Icon = stageIcons[stageKey] || Circle;
                  const job = jobByStage[stageKey];
                  const isCurrent = job?.status === 'running';
                  const isDone = job?.status === 'success';
                  const isError = ['failed', 'error', 'timeout'].includes(job?.status);
                  const isRetry = job?.status === 'retry';
                  return (
                    <div
                      key={stageKey}
                      className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium border transition-colors ${
                        isCurrent ? 'bg-primary/10 text-primary border-primary/30' :
                        isDone ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25' :
                        isError ? 'bg-destructive/10 text-destructive dark:text-rose-300 border-destructive/25' :
                        isRetry ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300 border-amber-500/25' :
                        'bg-muted/50 text-muted-foreground border-border/60'
                      }`}
                    >
                      {isDone ? <CheckCircle className="w-2.5 h-2.5" /> :
                       isError ? <AlertCircle className="w-2.5 h-2.5" /> :
                       isRetry ? <Clock className="w-2.5 h-2.5" /> :
                       isCurrent ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> :
                       <Icon className="w-2.5 h-2.5" />}
                      <span className="truncate max-w-[80px]">{stage?.label || stageKey.split('.').pop()}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* 3. Main Workspace: Transcript + Video */}
          <div className="flex-1 flex min-h-0">
            {/* Left Panel: Transcript Editor (dominant) */}
            <div className="w-[58%] flex flex-col min-h-0 border-r border-border">
              {outputStale && !isActive && (
                <div className="shrink-0 mx-3 mt-3 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
                  <AlertCircle className="w-4 h-4 shrink-0" /> Video hiện tại chưa phản ánh bản chỉnh sửa — nhấn Lồng tiếng lại để cập nhật.
                </div>
              )}
              <TranscriptEditor
                transcript={transcript}
                onSeek={handleSeek}
                hasVideo={!!outputUrl}
                onSave={handleSaveTranscript}
                onRedub={handleRedub}
                saving={savingTranscript}
                redubbing={redubbing}
                disabled={isActive}
                error={transcriptError}
                targetLanguage={targetLanguage}
                onLanguageChange={setTargetLanguage}
              />
            </div>

            {/* Right Panel: Video Preview */}
            <div className="w-[42%] flex flex-col min-h-0 bg-card border-l border-border overflow-y-auto">
              {/* §1: pipeline đang chạy → ẩn output, hiện tiến trình + stage hiện tại */}
              {isActive ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
                  <Loader2 className="w-8 h-8 animate-spin text-primary" />
                  <div className="text-sm font-semibold text-foreground">
                    Đang xử lý{typeof project.progress === 'number' ? ` — ${project.progress}%` : ''}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {(() => {
                      const cur = stages.map((k) => ({ key: k, job: jobByStage[k] })).find((s) => s.job?.status === 'running');
                      const label = cur ? (STAGE_LABELS[cur.key]?.label || cur.key) : 'Chuẩn bị pipeline';
                      return `Stage hiện tại: ${label}`;
                    })()}
                  </div>
                  <div className="text-[11px] text-muted-foreground/70 max-w-[260px]">
                    Video output sẽ xuất hiện khi pipeline hoàn thành — đây không phải kết quả cũ.
                  </div>
                </div>
              ) : outputUrl ? (
                <div className="flex-1 flex flex-col min-h-0 p-3 gap-2">
                  {/* Video Container */}
                  <div className="relative flex-1 min-h-0 bg-black rounded-xl overflow-hidden group">
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
                          <div className="w-14 h-14 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center border border-white/10 hover:bg-white/30 transition-colors">
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
                          <div className="w-14 h-14 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center border border-white/10">
                            <Pause className="w-6 h-6 text-white" />
                          </div>
                        </motion.button>
                      )}
                    </AnimatePresence>
                  </div>
                  {/* Video Info Bar */}
                  <div className="shrink-0 flex items-center justify-between text-[10px] text-muted-foreground px-1">
                    <span>{fmtSec(currentTime)} / {fmtSec(duration)}</span>
                    <span>{MODE_LABELS[project.mode] || project.mode}</span>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                  Chưa có video output
                </div>
              )}
              {/* Manual Mask Editor: che/làm mờ hardsub gốc trên video nguồn */}
              {isDub && (
                <div className="shrink-0 border-t border-border p-3">
                  <MaskEditor projectId={id} sourceUrl={sourceUrl} disabled={isActive} />
                </div>
              )}
            </div>
          </div>

          {/* 4. Simplified Timeline */}
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
        </div>
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
              {!isDub && ` • ${project.target_duration_sec}s`}
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
              </>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-6 flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}

        {/* Output preview */}
        {outputUrl && isVideoOutput && (
          <div className="rounded-2xl bg-card border border-border p-4 mb-6 shadow-sm">
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
              const isDone = job?.status === 'success';
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
                    {job?.error_message && <div className="text-xs text-destructive truncate mt-0.5 font-medium">{job.error_message}</div>}
                    {job && <div className="text-xs text-muted-foreground mt-0.5 font-mono">{formatDate(job.created_date)}{job.attempts > 1 ? ` • ${job.attempts} lần thử` : ''}</div>}
                  </div>
                  {!job && !isCurrent && !isDone && <Circle className="w-4 h-4 text-muted-foreground/30" />}
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* TRANSLATE_DUB: editor lời thoại song ngữ (sửa được) */}
        {isDub && (
          <TranscriptEditor
            transcript={transcript}
            onSeek={seekTo}
            hasVideo={!!outputUrl}
            onSave={handleSaveTranscript}
            onRedub={handleRedub}
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
    </Layout>
  );
}

function InfoGrid({ project, isDub, params }) {
  const rows = isDub
    ? [
        ['Chế độ', MODE_LABELS[project.mode] || project.mode],
        ['Ngôn ngữ', `${SOURCE_LANGUAGES[params.sourceLanguage ?? params.source_language] || params.sourceLanguage || 'Tự động'} → ${TARGET_LANGUAGES[params.targetLanguage ?? params.target_language] || project.language || 'vi'}`],
        ['Phong cách dịch', params.stylePreset ?? params.style_preset ?? '—'],
        ['Lồng tiếng AI', (params.enableDubbing ?? params.enable_dubbing) ? `Bật (${VOICE_PROVIDER_LABELS[params.voiceProvider] || params.voiceProvider || 'mặc định'})` : 'Tắt'],
      ]
    : [
        ['Chế độ', MODE_LABELS[project.mode] || project.mode],
        ['Ngôn ngữ', LANGUAGE_LABELS[project.language] || project.language],
        ['Thời lượng', `${project.target_duration_sec}s`],
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

function TranscriptEditor({ transcript, onSeek, hasVideo, onSave, onRedub, saving, redubbing, disabled, error, compact = false, targetLanguage = 'vi', onLanguageChange }) {
  // §7: chỉnh trực tiếp Original / Translation / Start / End. Không drag-and-drop.
  // edits: { [segmentId]: { text?, translation?, startSec?, endSec? } }
  const [edits, setEdits] = useState({});
  const [localError, setLocalError] = useState('');

  const getField = (seg, field) => (edits[seg.id]?.[field] !== undefined ? edits[seg.id][field] : seg[field]);
  const isDirtyRow = (s) => {
    const e = edits[s.id];
    if (!e) return false;
    return ['text', 'translation', 'startSec', 'endSec'].some((f) => e[f] !== undefined && e[f] !== s[f]);
  };
  const dirtyCount = transcript.filter(isDirtyRow).length;
  const translatedCount = transcript.filter((s) => String(getField(s, 'translation') || '').trim()).length;

  const setField = (seg, field, value) => {
    setLocalError('');
    setEdits((p) => ({ ...p, [seg.id]: { ...p[seg.id], [field]: value } }));
  };

  // Validation client: 0 <= start < end + không overlap câu trước/sau.
  // Server (OVERLAP_CONFLICT) là authority cuối; đây chỉ là pre-check nhanh.
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
      const { startSec, endSec } = eff(s);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || !(startSec >= 0) || !(endSec > startSec)) {
        return `Câu #${s.index ?? ''}: timing không hợp lệ (cần 0 ≤ start < end).`;
      }
      const i = sorted.findIndex((x) => x.id === s.id);
      if (i > 0 && startSec < Number(eff(sorted[i - 1]).endSec)) {
        return `Câu #${s.index ?? ''}: start (${startSec}s) overlap câu trước (kết thúc ${eff(sorted[i - 1]).endSec}s).`;
      }
      if (i < sorted.length - 1 && endSec > Number(eff(sorted[i + 1]).startSec)) {
        return `Câu #${s.index ?? ''}: end (${endSec}s) overlap câu sau (bắt đầu ${eff(sorted[i + 1]).startSec}s).`;
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
    const payload = changedPayload();
    if (!payload.length) return;
    const err = validatePayload(payload);
    if (err) {
      setLocalError(err);
      return;
    }
    const result = await onSave(payload);
    if (result === null) return;
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
    setEdits({});
    await onRedub();
  };

  // Compact mode for 2-panel layout
  if (compact) {
    if (!transcript.length) {
      return (
        <div className="h-full flex flex-col items-center justify-center p-6 text-center">
          <p className="text-xs text-muted-foreground">
            Chưa có lời thoại. Hãy chạy pipeline để nhận dạng.
          </p>
        </div>
      );
    }

    return (
      <div className="h-full flex flex-col bg-card">
        {/* Header */}
        <div className="shrink-0 p-3 border-b border-border bg-card">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h3 className="text-xs font-semibold text-foreground">Lời thoại song ngữ</h3>
            <span className="text-[10px] font-mono text-muted-foreground">{translatedCount}/{transcript.length}</span>
          </div>
          {/* Language Selector */}
          <div className="flex items-center gap-1.5 mb-2.5">
            <Languages className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <select
              value={targetLanguage}
              onChange={(e) => onLanguageChange?.(e.target.value)}
              disabled={disabled}
              className="flex-1 bg-background border border-input rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
            >
              <option value="vi">Tiếng Việt</option>
              <option value="en">Tiếng Anh</option>
              <option value="ja">Tiếng Nhật</option>
              <option value="ko">Tiếng Hàn</option>
              <option value="zh">Tiếng Trung</option>
            </select>
          </div>
          {error && (
            <div className="mb-2 flex items-center gap-1.5 text-[11px] text-destructive bg-destructive/10 rounded-md px-2 py-1">
              <AlertCircle className="w-3 h-3 shrink-0" /> {error}
            </div>
          )}
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || disabled || dirtyCount === 0}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md border border-emerald-500/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 text-xs font-semibold transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
              Lưu{dirtyCount > 0 ? ` (${dirtyCount})` : ''}
            </button>
            <button
              type="button"
              onClick={handleRedub}
              disabled={redubbing || disabled}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md border border-primary/30 text-primary hover:bg-primary/10 text-xs font-semibold transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {redubbing ? <Loader2 className="w-3 h-3 animate-spin" /> : <AudioLines className="w-3 h-3" />}
              Lồng tiếng
            </button>
          </div>
        </div>

        {/* Transcript list */}
        <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
          {localError && (
            <div className="flex items-center gap-1 text-[10px] text-destructive bg-destructive/10 rounded px-2 py-1">
              <AlertCircle className="w-2.5 h-2.5 shrink-0" /> {localError}
            </div>
          )}
          {transcript.map((seg, i) => (
            <SegmentCard
              key={seg.id || i}
              seg={seg}
              compact
              isDirty={isDirtyRow(seg)}
              getField={getField}
              onField={setField}
              onSeek={onSeek}
              hasVideo={hasVideo}
              disabled={disabled}
            />
          ))}
        </div>
      </div>
    );
  }

  // Full mode (original)
  if (!transcript.length) {
    return (
      <div className="rounded-2xl bg-card border border-border p-6 mb-6 shadow-sm">
        <h3 className="text-base font-semibold text-foreground">Lời thoại song ngữ</h3>
        <p className="text-sm text-muted-foreground mt-2">
          Chưa có lời thoại nào. Hãy chạy pipeline (hoặc nhấn <span className="text-primary font-medium">Chạy lại</span>) để AI nhận dạng và dịch video.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col rounded-2xl bg-card border border-border p-6 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-base font-semibold text-foreground">Lời thoại song ngữ (chỉnh sửa được)</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Gốc ↔ bản dịch{hasVideo ? ' — nhấn vào giờ để nhảy tới đoạn đó trong video' : ''}. Đã dịch {translatedCount}/{transcript.length} câu.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Language Selector */}
          <div className="flex items-center gap-1.5">
            <Languages className="w-3.5 h-3.5 text-muted-foreground" />
            <select
              value={targetLanguage}
              onChange={(e) => onLanguageChange?.(e.target.value)}
              disabled={disabled}
              className="bg-background border border-input rounded-lg px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
            >
              <option value="vi">Tiếng Việt</option>
              <option value="en">Tiếng Anh</option>
              <option value="ja">Tiếng Nhật</option>
              <option value="ko">Tiếng Hàn</option>
              <option value="zh">Tiếng Trung</option>
            </select>
          </div>
          <button onClick={handleSave} disabled={saving || disabled || dirtyCount === 0}
            className="flex items-center gap-2 px-3 py-2 rounded-xl border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 text-sm font-semibold transition disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            Lưu chỉnh sửa{dirtyCount > 0 ? ` (${dirtyCount})` : ''}
          </button>
          <button onClick={handleRedub} disabled={redubbing || disabled}
            className="flex items-center gap-2 px-3 py-2 rounded-xl border border-primary/30 text-primary hover:bg-primary/10 text-sm font-semibold transition disabled:opacity-50">
            {redubbing ? <Loader2 className="w-4 h-4 animate-spin" /> : <AudioLines className="w-4 h-4" />}
            Chạy lại (lồng tiếng)
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {localError && (
        <div className="mb-4 flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3">
          <AlertCircle className="w-4 h-4 shrink-0" /> {localError}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
        {transcript.map((seg, i) => (
          <SegmentCard
            key={seg.id || i}
            seg={seg}
            isDirty={isDirtyRow(seg)}
            getField={getField}
            onField={setField}
            onSeek={onSeek}
            hasVideo={hasVideo}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}

// §7: thẻ subtitle chỉnh trực tiếp 4 trường (Original / Translation / Start / End).
// Không kéo-thả, không draggable/dataTransfer.
function SegmentCard({ seg, compact = false, isDirty, getField, onField, onSeek, hasVideo, disabled }) {
  const numCls = 'w-full bg-background border border-input rounded-md px-2 py-1 text-xs text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60 font-mono';
  const areaCls = compact
    ? 'w-full resize-none rounded-md bg-background border border-input px-2.5 py-1 text-xs text-foreground leading-snug focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60'
    : 'w-full resize-y rounded-md bg-background border border-input px-3 py-1.5 text-xs sm:text-sm text-foreground leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60';

  return (
    <div className={`p-3 rounded-lg border transition-colors ${
      isDirty ? 'bg-amber-500/10 border-amber-500/30' : 'bg-card border-border hover:border-border/90'
    }`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <button
          type="button"
          onClick={() => onSeek(Number(getField(seg, 'startSec')))}
          disabled={!hasVideo}
          className="text-xs font-semibold text-muted-foreground hover:text-primary transition-colors disabled:cursor-default tabular-nums font-mono inline-flex items-center gap-1"
        >
          <span>{fmtSec(getField(seg, 'startSec'))}</span>
          <span>→</span>
          <span>{fmtSec(getField(seg, 'endSec'))}</span>
        </button>
        <span className="flex items-center gap-1.5">
          {seg.speaker && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-primary/10 text-primary">{seg.speaker}</span>
          )}
          {isDirty && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-amber-500/15 text-amber-800 dark:text-amber-300">đã sửa</span>
          )}
        </span>
      </div>
      <div>
        <label className="block text-[11px] font-semibold text-muted-foreground mb-1">Original (Câu gốc)</label>
        <textarea
          value={getField(seg, 'text') ?? ''}
          onChange={(e) => onField(seg, 'text', e.target.value)}
          disabled={disabled}
          rows={compact ? 1 : 2}
          placeholder="Câu gốc (OCR/STT)"
          className={areaCls}
        />
      </div>
      <div className="mt-2">
        <label className="block text-[11px] font-semibold text-muted-foreground mb-1">Translation (Bản dịch)</label>
        <textarea
          value={getField(seg, 'translation') ?? ''}
          onChange={(e) => onField(seg, 'translation', e.target.value)}
          disabled={disabled}
          rows={compact ? 1 : 2}
          placeholder="Bản dịch — sửa tay được giữ nguyên khi chạy lại"
          className={areaCls}
        />
      </div>
      <div className="grid grid-cols-2 gap-2 mt-2">
        <label className="block text-[11px] font-semibold text-muted-foreground">Start (giây)
          <input
            type="number" step={0.1} min={0}
            value={getField(seg, 'startSec') ?? 0}
            onChange={(e) => onField(seg, 'startSec', Number(e.target.value))}
            disabled={disabled}
            className={`mt-1 ${numCls}`}
          />
        </label>
        <label className="block text-[11px] font-semibold text-muted-foreground">End (giây)
          <input
            type="number" step={0.1} min={0}
            value={getField(seg, 'endSec') ?? 0}
            onChange={(e) => onField(seg, 'endSec', Number(e.target.value))}
            disabled={disabled}
            className={`mt-1 ${numCls}`}
          />
        </label>
      </div>
    </div>
  );
}
