import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Trash2, XCircle, RotateCcw, Loader2, Play, Download, AlertCircle, ChevronDown } from 'lucide-react';
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
  const [showRerunMenu, setShowRerunMenu] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setShowRerunMenu(false);
      }
    }
    if (showRerunMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showRerunMenu]);

  const isDubMode = project?.mode !== 'SUMMARY';
  const stageOptions = isDubMode ? [
    { label: 'Tự động (tiếp tục theo tiến độ)', stage: null },
    { label: 'Từ bước Dịch thuật', stage: 'dub.translate' },
    { label: 'Từ bước Lồng tiếng (TTS)', stage: 'dub.ttsAlign' },
    { label: 'Từ bước Render video', stage: 'dub.render' },
  ] : [
    { label: 'Tự động (tiếp tục theo tiến độ)', stage: null },
    { label: 'Từ bước Kịch bản', stage: 'summary.script' },
    { label: 'Từ bước Tạo giọng (TTS)', stage: 'summary.tts' },
    { label: 'Từ bước Render video', stage: 'summary.render' },
  ];

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
            <div className="relative inline-flex items-center" ref={menuRef}>
              <button
                type="button"
                onClick={() => onRegenerate()}
                disabled={regenerating}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-l-lg border border-primary/30 text-primary hover:bg-primary/10 text-xs font-semibold transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {regenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Chạy lại
              </button>
              <button
                type="button"
                onClick={() => setShowRerunMenu((prev) => !prev)}
                disabled={regenerating}
                title="Chọn bước chạy lại cụ thể"
                className="inline-flex items-center px-1.5 py-1.5 rounded-r-lg border-y border-r border-primary/30 text-primary hover:bg-primary/10 text-xs font-semibold transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              {showRerunMenu && (
                <div className="absolute top-full right-0 mt-1 w-56 py-1 bg-card border border-border rounded-lg shadow-xl z-50 animate-in fade-in zoom-in-95 duration-100">
                  <div className="px-3 py-1.5 text-[11px] font-semibold text-muted-foreground border-b border-border/50 uppercase tracking-wider">
                    Chạy lại theo giai đoạn
                  </div>
                  {stageOptions.map((opt) => (
                    <button
                      key={opt.stage || 'auto'}
                      type="button"
                      onClick={() => {
                        setShowRerunMenu(false);
                        onRegenerate(opt.stage);
                      }}
                      className="w-full text-left px-3 py-2 text-xs text-foreground hover:bg-muted transition flex items-center justify-between"
                    >
                      <span>{opt.label}</span>
                      {opt.stage && <span className="text-[10px] text-muted-foreground font-mono">{opt.stage.split('.')[1]}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
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
