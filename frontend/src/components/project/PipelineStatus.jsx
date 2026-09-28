import { motion } from 'framer-motion';
import {
  FileText, Scissors, Sparkles, Combine, Mic, Captions, Video, FileAudio,
  Languages, AudioLines, Circle, Loader2, CheckCircle, AlertCircle, Clock,
} from 'lucide-react';
import { STAGE_LABELS } from '@/lib/constants';

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

export default function PipelineStatus({
  progress,
  isActive,
  sseAvailable,
  stages = [],
  jobByStage = {},
}) {
  return (
    <div className="shrink-0 px-4 py-2.5 bg-card border-b border-border">
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
  );
}
