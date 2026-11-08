import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Clapperboard, Sparkles } from 'lucide-react';
import { projectsApi } from '@/api/projects';

export default function ComposerLauncher() {
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const payload = {
          mode: 'MEDIA_COMPOSER',
          title: 'Dự án AI Media Composer mới',
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
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-background p-6 text-center">
        <div className="w-12 h-12 rounded-2xl bg-destructive/10 text-destructive flex items-center justify-center mb-4">
          <Clapperboard className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-foreground">Không thể mở AI Media Composer</h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-md">{error}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold transition"
        >
          Thử lại
        </button>
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
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>Đang mở không gian biên tập video...</span>
        </div>
      </div>
    </div>
  );
}
