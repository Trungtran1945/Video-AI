import { Link } from 'react-router-dom';
import { ArrowLeft, Trash2, XCircle, RotateCcw, Loader2, Play, Download, AlertCircle } from 'lucide-react';
import { StatusBadge } from '@/lib/constants';

export default function ProjectHeader({
  project,
  canCancel,
  canRegenerate,
  regenerating,
  outputUrl,
  error,
  onConfirmDelete,
  onCancel,
  onRegenerate,
}) {
  return (
    <div className="shrink-0 px-4 py-3 border-b border-border bg-card">
      <Link to="/projects" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-2 transition">
        <ArrowLeft className="w-3 h-3" /> Quay lại dự án
      </Link>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-lg font-bold text-foreground truncate">{project?.title}</h1>
          <StatusBadge status={project?.status} />
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          <button
            type="button"
            onClick={onConfirmDelete}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
          >
            <Trash2 className="w-3.5 h-3.5" /> Xoá
          </button>
          {canCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/30 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <XCircle className="w-3.5 h-3.5" /> Huỷ
            </button>
          )}
          {canRegenerate && (
            <button
              type="button"
              onClick={onRegenerate}
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
  );
}
