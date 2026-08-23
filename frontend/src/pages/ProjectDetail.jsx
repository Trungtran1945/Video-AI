import { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { projectsApi } from '@/api/projects';
import Layout from '@/components/Layout';
import Loading from '@/components/Loading';
import { motion } from 'framer-motion';
import { ArrowLeft, FileText, Image, Video, Mic, Captions, CheckCircle, Loader2, Circle, AlertCircle, Play, Download, RotateCcw, Scissors, Sparkles, Combine, Clapperboard, Film, Trash2 } from 'lucide-react';
import { STAGE_LABELS, StatusBadge, formatDate, LANGUAGE_LABELS, STYLE_LABELS, VOICE_PROVIDER_LABELS } from '@/lib/constants';
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
  'style.analyze': Sparkles,
  'style.storyboard': Clapperboard,
  'style.tts': Mic,
  'style.render': Video,
};

const MODE_STAGES = {
  SUMMARY: ['summary.transcribe', 'summary.sceneDetect', 'summary.analyze', 'summary.script', 'summary.align', 'summary.tts', 'summary.subtitle', 'summary.render'],
  STYLE_EDIT: ['style.analyze', 'style.storyboard', 'style.tts', 'style.render'],
};

const ACTIVE_STATUSES = ['pending', 'queued', 'generating', 'running'];

const POLL_INTERVAL_MS = 3000;

function fmtSec(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function ProjectDetail() {
  const { id } = useParams();
  const [project, setProject] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [scenes, setScenes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { toast } = useToast();

  const load = useCallback(async () => {
    try {
      const p = await projectsApi.get(id);
      setProject(p);
      setJobs(p.jobs || []);
      setScenes(p.mode === 'SUMMARY' ? (p.scenes || []) : (p.assets || []));
      return p;
    } catch (e) {
      console.error(e);
      return null;
    }
  }, [id]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  // Poll progress while pipeline is active
  useEffect(() => {
    if (!project || !ACTIVE_STATUSES.includes(project.status)) return undefined;
    const t = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [project?.status, load]);

  const isActive = project && ACTIVE_STATUSES.includes(project.status);
  const canRegenerate = project && ['completed', 'failed'].includes(project.status);

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

  if (loading) return <Layout><Loading /></Layout>;
  if (!project) return <Layout><div className="p-8 text-center text-slate-400">Không tìm thấy dự án.</div></Layout>;

  const jobByStage = {};
  (jobs || []).forEach(j => { if (!jobByStage[j.type]) jobByStage[j.type] = j; });
  const stages = MODE_STAGES[project.mode] || [];
  const timeline = project.timeline || [];
  const outputUrl = project.output?.storage_key ? `/storage/${project.output.storage_key}` : null;
  const isVideoOutput = /\.(mp4|webm|mov|m4v|mkv)$/i.test(project.output?.storage_key || '');

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-5xl mx-auto">
        <Link to="/projects" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white mb-4 transition">
          <ArrowLeft className="w-4 h-4" /> Quay lại dự án
        </Link>

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-bold text-white">{project.title}</h1>
              <StatusBadge status={project.status} />
            </div>
            <p className="text-sm text-slate-400">{project.mode === 'SUMMARY' ? 'Review phim' : 'Edit theo mẫu'} • {project.target_duration_sec}s</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-red-500/30 text-red-400 hover:bg-red-500/10 text-sm font-semibold transition">
              <Trash2 className="w-4 h-4" /> Xoá
            </button>
            {canRegenerate && (
              <button onClick={handleRegenerate} disabled={regenerating}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 text-sm font-semibold transition disabled:opacity-50">
                {regenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} Chạy lại
              </button>
            )}
            {outputUrl && (
              <>
                <a href={outputUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition">
                  <Play className="w-4 h-4" /> Xem video
                </a>
                <a href={outputUrl} download className="flex items-center gap-2 px-4 py-2 rounded-xl border border-white/10 hover:border-white/20 text-slate-300 text-sm font-semibold transition">
                  <Download className="w-4 h-4" /> Tải về
                </a>
              </>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-6 flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}

        {/* Output preview */}
        {outputUrl && isVideoOutput && (
          <div className="rounded-2xl bg-[#161922] border border-white/5 p-4 mb-6">
            <video src={outputUrl} controls className="w-full max-h-[420px] rounded-xl bg-black" />
          </div>
        )}

        {/* Info grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {[
            ['Chế độ', project.mode === 'SUMMARY' ? 'Review phim' : 'Edit theo mẫu'],
            ['Ngôn ngữ', LANGUAGE_LABELS[project.language] || project.language],
            ['Thời lượng', `${project.target_duration_sec}s`],
            ['Phong cách', STYLE_LABELS[project.style] || project.style],
            ['Giọng nói', VOICE_PROVIDER_LABELS[project.params?.voiceProvider] || project.params?.voiceProvider || '—'],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl bg-[#161922] border border-white/5 p-4">
              <div className="text-xs text-slate-500">{k}</div>
              <div className="text-sm font-medium text-slate-200 mt-1">{v}</div>
            </div>
          ))}
        </div>

        {/* Pipeline progress */}
        <div className="rounded-2xl bg-[#161922] border border-white/5 p-6 mb-6">
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-base font-semibold text-white">Tiến trình Pipeline</h3>
            {isActive && (
              <span className="inline-flex items-center gap-1.5 text-xs text-blue-400">
                <Loader2 className="w-3 h-3 animate-spin" /> Tự động cập nhật
              </span>
            )}
          </div>

          {typeof project.progress === 'number' && (
            <div className="mb-5">
              <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-500"
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(100, Math.max(0, project.progress))}%` }}
                  transition={{ duration: 0.4 }}
                />
              </div>
              <div className="text-xs text-slate-500 mt-1.5 text-right">{project.progress}%</div>
            </div>
          )}

          <div className="space-y-3">
            {stages.map((stageKey, i) => {
              const stage = STAGE_LABELS[stageKey];
              const Icon = stageIcons[stageKey] || Circle;
              const job = jobByStage[stageKey];
              const isCurrent = job?.status === 'running';
              const isDone = job?.status === 'success';
              const isError = ['failed', 'error', 'timeout'].includes(job?.status);

              return (
                <motion.div
                  key={stageKey}
                  initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className={`flex items-center gap-4 p-3 rounded-xl transition ${
                    isCurrent ? 'bg-blue-500/10 border border-blue-500/20' : 'border border-transparent'
                  }`}
                >
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                    isDone ? 'bg-emerald-500/15 text-emerald-400' :
                    isError ? 'bg-red-500/15 text-red-400' :
                    isCurrent ? 'bg-blue-500/15 text-blue-400' : 'bg-white/5 text-slate-500'
                  }`}>
                    {isDone ? <CheckCircle className="w-4 h-4" /> :
                     isError ? <AlertCircle className="w-4 h-4" /> :
                     isCurrent ? <Loader2 className="w-4 h-4 animate-spin" /> :
                     <Icon className="w-4 h-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-200">{stage?.label || stageKey}</div>
                    {job?.error_message && <div className="text-xs text-red-400 truncate">{job.error_message}</div>}
                    {job && <div className="text-xs text-slate-500">{formatDate(job.created_date)}{job.attempts > 1 ? ` • ${job.attempts} lần thử` : ''}</div>}
                  </div>
                  {!job && !isCurrent && !isDone && <Circle className="w-4 h-4 text-slate-700" />}
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Timeline preview */}
        {timeline.length > 0 && (
          <div className="rounded-2xl bg-[#161922] border border-white/5 p-6 mb-6">
            <h3 className="text-base font-semibold text-white">Bản dựng (Timeline)</h3>
            <p className="text-xs text-slate-500 mt-1 mb-4">Xem trước các clip theo thứ tự AI đã dựng — chỉ xem, dùng &quot;Chạy lại&quot; nếu chưa ưng ý.</p>
            <div className="flex gap-2 overflow-x-auto pb-2">
              {timeline.map((clip, i) => (
                <div key={clip.id || i} className="shrink-0 w-36 rounded-xl border border-white/5 bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-slate-500">#{clip.order_index ?? i + 1}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 uppercase">{clip.source_type === 'ASSET' ? 'Asset' : 'Scene'}</span>
                  </div>
                  <div className="w-full h-12 rounded-lg bg-gradient-to-br from-blue-500/20 to-indigo-600/20 flex items-center justify-center mb-2">
                    <Film className="w-4 h-4 text-blue-300" />
                  </div>
                  <div className="text-xs text-slate-300 tabular-nums">{fmtSec(clip.in_sec)} → {fmtSec(clip.out_sec)}</div>
                  <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-500">
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

        {/* Scenes / Assets */}
        {scenes.length > 0 && (
          <div className="rounded-2xl bg-[#161922] border border-white/5 p-6">
            <h3 className="text-base font-semibold text-white mb-4">
              {project.mode === 'SUMMARY' ? `Cảnh (${scenes.length})` : `Assets (${scenes.length})`}
            </h3>
            <div className="space-y-3">
              {scenes.map((item, i) => (
                <div key={item.id} className="flex gap-4 p-3 rounded-xl bg-white/[0.02] border border-white/5">
                  <div className="text-2xl font-bold text-slate-600 w-8 text-center">{i + 1}</div>
                  <div className="w-20 h-20 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
                    <Image className="w-5 h-5 text-slate-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    {project.mode === 'SUMMARY' ? (
                      <>
                        <div className="text-sm text-slate-300 line-clamp-2">{item.description}</div>
                        <div className="flex items-center gap-3 mt-2 text-xs text-slate-500">
                          <span>{item.start_sec}s – {item.end_sec}s</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="text-sm text-slate-300">{item.kind}</div>
                        <div className="text-xs text-slate-500 mt-1 truncate">{item.storage_key}</div>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent className="bg-[#161922] border-white/10 text-slate-200">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white">Xoá dự án này?</AlertDialogTitle>
            <AlertDialogDescription>
              Dự án “{project.title}” cùng video nguồn, giọng đọc, phụ đề và video render sẽ bị xoá vĩnh viễn khỏi kho lưu trữ. Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-transparent border-white/10 text-slate-300 hover:bg-white/5 hover:text-white">
              Huỷ
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDelete(); }}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-500 text-white"
            >
              {deleting ? 'Đang xoá...' : 'Xoá vĩnh viễn'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
