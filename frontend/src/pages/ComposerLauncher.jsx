import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Clapperboard, Sparkles, ArrowLeft, RefreshCw } from 'lucide-react';
import { projectsApi } from '@/api/projects';

export default function ComposerLauncher() {
  const navigate = useNavigate();
  const [error, setError] = useState(null);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;

    let alive = true;
    (async () => {
      try {
        const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        const payload = {
          mode: 'MEDIA_COMPOSER',
          title: `Dự án AI Media Composer mới (${timeStr})`,
          aspectRatio: '16:9',
          copyrightAcknowledged: true,
          params: {
            resolution: '1080p',
            fps: 30,
            outputFormat: 'mp4',
            defaultBackground: '#0F1117',
          },
        };

        const res = await projectsApi.create(payload);
        if (!alive) return;
        const targetId = res?.id || res?.project?.id;
        if (targetId) {
          navigate(`/projects/${targetId}`, { replace: true });
        } else {
          throw new Error('Không nhận được ID dự án từ máy chủ');
        }
      } catch (err) {
        if (!alive) return;
        console.error('Composer launcher error:', err);
        setError(err?.response?.data?.message || err.message || 'Lỗi khi khởi tạo dự án');
      }
    })();

    return () => {
      alive = false;
    };
  }, [navigate]);

  if (error) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-background p-6 text-center select-none">
        <div className="w-14 h-14 rounded-2xl bg-destructive/10 text-destructive flex items-center justify-center mb-4 border border-destructive/20 shadow-sm">
          <Clapperboard className="w-7 h-7" />
        </div>
        <h2 className="text-lg font-bold text-foreground">Không thể mở AI Media Composer</h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-md">{error}</p>
        <div className="flex items-center gap-3 mt-6">
          <button
            type="button"
            onClick={() => navigate('/projects')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border bg-background hover:bg-muted text-foreground text-xs font-semibold transition cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Về danh sách dự án</span>
          </button>
          <button
            type="button"
            onClick={() => {
              requestedRef.current = false;
              window.location.reload();
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold transition cursor-pointer shadow-sm"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Thử lại</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-background/95 backdrop-blur-xs select-none">
      <div className="relative flex flex-col items-center">
        <div className="w-16 h-16 rounded-3xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shadow-xl shadow-primary/5 mb-4 animate-pulse">
          <Clapperboard className="w-8 h-8" />
        </div>
        <div className="flex items-center gap-2 text-foreground font-bold text-base tracking-tight">
          <span>AI Media Composer</span>
          <Sparkles className="w-4 h-4 text-primary animate-spin" />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
          <span>Đang mở không gian biên tập video...</span>
        </div>
      </div>
    </div>
  );
}
