import { motion } from 'framer-motion';
import {
  FileText, Scissors, Sparkles, Combine, Mic, Captions, Video, FileAudio,
  Languages, AudioLines, Circle, Loader2, CheckCircle, AlertCircle, AlertTriangle, Clock, RotateCcw,
} from 'lucide-react';
import { STAGE_LABELS } from '@/lib/constants';
import { friendlyJobError } from '@/lib/providerErrorMessage';

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
  'dub.ttsAlign': AudioLines,
  'dub.render': Video,
};

// Pinned pipeline stepper (TransFlow-inspired): sticky, numbered, per-stage
// status + attempt/max + Retry for failed stages. Read-only except onRetry.
export default function PipelineStatus({
  progress,
  isActive,
  sseAvailable,
  stages = [],
  jobByStage = {},
  onRetry = null,
  retryingStage = null,
}) {
  // Find any stage that is in retry status awaiting quota recovery
  const activeRetryStageKey = stages.find((s) => jobByStage[s]?.status === 'retry');
  let activeRetryMessage = null;
  if (activeRetryStageKey) {
    const rJob = jobByStage[activeRetryStageKey];
    const nr = rJob?.next_retry_at || rJob?.nextRetryAt;
    let timeStr = '';
    if (nr) {
      try {
        const d = new Date(nr);
        if (!isNaN(d.getTime())) {
          timeStr = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        }
      } catch {}
    }
    const stageLabel = STAGE_LABELS[activeRetryStageKey]?.label || activeRetryStageKey;
    activeRetryMessage = timeStr
      ? `Stage ${stageLabel}: Đang chờ quota provider hồi phục lúc ${timeStr}`
      : `Stage ${stageLabel}: Đang chờ quota provider hồi phục`;
  }

  return (
    <div className="sticky top-0 z-10 shrink-0 px-4 py-2.5 bg-card border-b border-border">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] font-bold text-foreground">Pipeline</span>
          {isActive && (
            <span
              className="inline-flex items-center gap-1 text-[11px] text-primary font-semibold"
              title={sseAvailable ? 'Realtime (SSE)' : 'Fallback polling'}
            >
              <Loader2 className="w-2.5 h-2.5 animate-spin" /> {sseAvailable ? 'Trực tiếp' : 'Đồng bộ định kỳ'}
            </span>
          )}
        </div>
        {typeof progress === 'number' && (
          <div className="flex-1 max-w-xs">
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <motion.div
                className="h-full rounded-full bg-primary"
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                transition={{ duration: 0.4 }}
              />
            </div>
          </div>
        )}
        <div className="flex-1 flex flex-wrap gap-1.5">
          {stages.map((stageKey, idx) => {
            const stage = STAGE_LABELS[stageKey];
            const Icon = stageIcons[stageKey] || Circle;
            const job = jobByStage[stageKey];
            const isCurrent = job?.status === 'running';
            const isDone = job?.status === 'success';
            const isError = ['failed', 'error', 'timeout'].includes(job?.status);
            const isRetry = job?.status === 'retry';
            const nextRetry = job?.next_retry_at || job?.nextRetryAt;

            let retryTimeStr = '';
            if (nextRetry) {
              try {
                const d = new Date(nextRetry);
                if (!isNaN(d.getTime())) {
                  retryTimeStr = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
                }
              } catch {}
            }
            const retryLabel = retryTimeStr
              ? `Đang chờ quota provider hồi phục lúc ${retryTimeStr}`
              : 'Đang chờ quota provider hồi phục';

            let hasQuotaRisk = false;
            let quotaRiskMessage = '';
            if (job?.result) {
              try {
                const res = typeof job.result === 'string' ? JSON.parse(job.result) : job.result;
                const warnings = Array.isArray(res?.warnings) ? res.warnings : [];
                const qr = warnings.find((w) => w?.type === 'quota_risk');
                if (qr) {
                  hasQuotaRisk = true;
                  quotaRiskMessage = qr.message || 'Sắp chạm giới hạn API — có thể chậm hơn dự kiến';
                }
              } catch {}
            }

            const attempts = job?.attempts;
            const maxAttempts = job?.max_attempts ?? job?.maxAttempts;
            const attemptText = attempts != null && maxAttempts != null
              ? ` ${attempts}/${maxAttempts}`
              : attempts != null ? ` #${attempts}` : '';

            const title = isRetry
              ? `${idx + 1}. ${stage?.label || stageKey} — ${retryLabel}${attemptText}`
              : `${idx + 1}. ${stage?.label || stageKey}${job?.status ? ` — ${job.status}${attemptText}` : ''}${
                  job?.error_message ? `: ${friendlyJobError(job.error_message)}` : ''
                }${hasQuotaRisk ? ` [${quotaRiskMessage}]` : ''}`;

            return (
              <div
                key={stageKey}
                title={title}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium border transition-colors ${
                  isCurrent ? 'bg-primary/10 text-primary border-primary/30' :
                  isDone ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25' :
                  isError ? 'bg-destructive/10 text-destructive dark:text-rose-300 border-destructive/25' :
                  isRetry ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/35' :
                  'bg-muted/50 text-muted-foreground border-border/60'
                }`}
              >
                <span className="font-mono font-bold opacity-70">{idx + 1}</span>
                {isDone ? <CheckCircle className="w-2.5 h-2.5" /> :
                 isError ? <AlertCircle className="w-2.5 h-2.5" /> :
                 isRetry ? <Clock className="w-2.5 h-2.5 text-amber-500 animate-pulse" /> :
                 isCurrent ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> :
                 <Icon className="w-2.5 h-2.5" />}
                <span className="truncate max-w-[80px]">{stage?.label || stageKey.split('.').pop()}</span>
                {isRetry && retryTimeStr && (
                  <span className="font-mono text-amber-600 dark:text-amber-400 font-semibold">{retryTimeStr}</span>
                )}
                {hasQuotaRisk && (
                  <AlertTriangle className="w-2.5 h-2.5 text-amber-500 shrink-0" title={quotaRiskMessage} />
                )}
                {attemptText && !isRetry && (
                  <span className="font-mono opacity-70">{attemptText}</span>
                )}
                {isError && onRetry && (
                  <button
                    type="button"
                    title={`Thử lại stage ${stage?.label || stageKey}`}
                    disabled={retryingStage === stageKey}
                    onClick={(e) => { e.stopPropagation(); onRetry(stageKey); }}
                    className="ml-0.5 inline-flex items-center gap-0.5 text-destructive hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    {retryingStage === stageKey
                      ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
                      : <RotateCcw className="w-2.5 h-2.5" />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {activeRetryMessage && (
        <div className="mt-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-xs text-amber-700 dark:text-amber-300 font-medium">
          <Clock className="w-3.5 h-3.5 text-amber-500 shrink-0 animate-pulse" />
          <span>{activeRetryMessage}</span>
        </div>
      )}
    </div>
  );
}
