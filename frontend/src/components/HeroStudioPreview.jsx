import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Film, Languages, Play, Pause, Sparkles, Volume2,
  Cpu, Sliders, CheckCircle2, Subtitles, Layers, Clock
} from 'lucide-react';

export default function HeroStudioPreview() {
  const [activeMode, setActiveMode] = useState('review'); // 'review' | 'dubbing'
  const [isPlaying, setIsPlaying] = useState(true);
  const [progress, setProgress] = useState(38);

  // Automatic timeline scrubber simulation
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setProgress((prev) => (prev >= 100 ? 0 : prev + 0.6));
    }, 100);
    return () => clearInterval(interval);
  }, [isPlaying]);

  return (
    <div className="relative w-full max-w-5xl mx-auto mt-12 sm:mt-16 text-left">
      {/* Ambient background glow behind the preview card */}
      <div className="absolute -inset-1.5 bg-gradient-to-r from-blue-500/20 via-indigo-500/25 to-cyan-500/20 rounded-3xl blur-2xl opacity-70 pointer-events-none -z-10" />

      {/* Main Studio Console Frame */}
      <div className="relative rounded-2xl sm:rounded-3xl bg-card/85 dark:bg-card/75 border border-border/80 shadow-2xl backdrop-blur-xl overflow-hidden transition-all">
        
        {/* Top Console Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-3.5 border-b border-border/70 bg-muted/30">
          
          {/* Mode Switcher Tabs */}
          <div className="flex items-center gap-1.5 p-1 rounded-xl bg-background/80 border border-border/70 shadow-xs">
            <button
              onClick={() => {
                setActiveMode('review');
                setProgress(25);
              }}
              className={`flex items-center gap-2 px-3 sm:px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeMode === 'review'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
            >
              <Film className="w-3.5 h-3.5" />
              <span>Review Phim Tự Động</span>
            </button>

            <button
              onClick={() => {
                setActiveMode('dubbing');
                setProgress(45);
              }}
              className={`flex items-center gap-2 px-3 sm:px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeMode === 'dubbing'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
            >
              <Languages className="w-3.5 h-3.5" />
              <span>Dịch &amp; Lồng Tiếng</span>
            </button>
          </div>

          {/* Engine Status Indicators */}
          <div className="hidden sm:flex items-center gap-4 text-[11px] font-mono text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-foreground font-medium">SSE: Real-time</span>
            </div>
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-muted/60 border border-border/60">
              <Cpu className="w-3 h-3 text-primary" />
              <span>Pipeline: Active</span>
            </div>
            <div className="hidden lg:block text-muted-foreground/75">
              Res: 1080p 60fps
            </div>
          </div>
        </div>

        {/* Viewport Canvas Area */}
        <div className="p-4 sm:p-6 lg:p-7">
          <AnimatePresence mode="wait">
            {activeMode === 'review' ? (
              <motion.div
                key="review-mode"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.25 }}
                className="space-y-5"
              >
                {/* Visual Viewport & Analysis Stats */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                  {/* Video Scene Keyframe Viewport */}
                  <div className="lg:col-span-8 relative aspect-video rounded-xl sm:rounded-2xl bg-slate-950 border border-border/80 overflow-hidden flex flex-col justify-between p-4 shadow-inner">
                    {/* Simulated Cinematic Scene Background */}
                    <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-blue-950/40 to-slate-950 pointer-events-none" />
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_40%_40%,rgba(59,130,246,0.18),transparent_60%)] pointer-events-none" />
                    
                    {/* Scene Tag & Confidence */}
                    <div className="relative z-10 flex items-center justify-between">
                      <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-black/60 border border-white/10 text-white text-[11px] font-mono backdrop-blur-md">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                        <span>Phát hiện cảnh 03 / 08</span>
                      </div>
                      <div className="px-2 py-0.5 rounded-md bg-blue-500/20 text-blue-300 text-[10px] font-mono border border-blue-400/30">
                        Độ chính xác: 99.4%
                      </div>
                    </div>

                    {/* AI Vision Tracking Bounding Boxes */}
                    <div className="relative z-10 flex items-center justify-center py-6">
                      <div className="relative border border-cyan-400/60 rounded-lg px-6 py-4 bg-cyan-500/5 shadow-[0_0_15px_rgba(6,182,212,0.15)]">
                        <div className="absolute -top-2 left-2 px-1.5 bg-slate-950 text-[9px] font-mono text-cyan-300 border border-cyan-400/40 rounded">
                          NHÂN VẬT CHÍNH • KHUNG HÌNH VÀNG
                        </div>
                        <p className="text-xs sm:text-sm text-slate-200 font-medium text-center">
                          Điểm cao trào kịch tính (Climax Beat)
                        </p>
                        <p className="text-[10px] text-slate-400 text-center font-mono mt-0.5">
                          Thời gian gốc: 01:24:15 → Rút gọn: 00:14:28
                        </p>
                      </div>
                    </div>

                    {/* AI Generated Synopsis Overlay */}
                    <div className="relative z-10 p-3 rounded-xl bg-black/70 border border-white/10 backdrop-blur-md">
                      <div className="flex items-center gap-2 text-primary text-xs font-semibold mb-1">
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Lời bình luận AI tự động sinh:</span>
                      </div>
                      <p className="text-xs text-slate-200 leading-relaxed font-sans line-clamp-2 sm:line-clamp-1">
                        &ldquo;Ngay khoảnh khắc người bảo vệ mở cánh cổng số 4, toàn bộ bí mật của hạm đội đã bị vạch trần trước khi con tàu kịp tăng tốc...&rdquo;
                      </p>
                    </div>
                  </div>

                  {/* AI Metadata & Highlights sidebar */}
                  <div className="lg:col-span-4 flex flex-col justify-between gap-3 p-4 rounded-xl sm:rounded-2xl bg-muted/40 border border-border/70">
                    <div>
                      <div className="flex items-center justify-between pb-2 border-b border-border/60">
                        <span className="text-xs font-bold text-foreground">Thông Số Phân Tích</span>
                        <span className="text-[10px] font-mono text-muted-foreground">Video 142 phút</span>
                      </div>

                      <div className="mt-3 space-y-2.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Cảnh quan trọng:</span>
                          <span className="font-semibold text-foreground font-mono">8 trường đoạn</span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Thời lượng thành phẩm:</span>
                          <span className="font-semibold text-primary font-mono">22 phút 40 giây</span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Giọng đọc bình luận:</span>
                          <span className="font-semibold text-foreground">Nam Truyền Cảm</span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Khung hình xuất:</span>
                          <span className="font-semibold text-foreground font-mono">9:16 Shorts &amp; 16:9</span>
                        </div>
                      </div>
                    </div>

                    <div className="p-3 rounded-xl bg-primary/10 border border-primary/20">
                      <div className="flex items-center gap-2 text-primary text-xs font-bold">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        <span>Tự Động Hóa 100%</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1 leading-normal">
                        Tiết kiệm hơn 4 tiếng cắt ghép &amp; thu âm thủ công cho mỗi tập review.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Multi-track Video Timeline Visualizer */}
                <div className="p-3.5 sm:p-4 rounded-xl sm:rounded-2xl bg-muted/30 border border-border/70 space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setIsPlaying(!isPlaying)}
                        className="w-7 h-7 rounded-lg bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 transition-colors shadow-xs"
                      >
                        {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
                      </button>
                      <span className="font-mono font-semibold text-foreground">00:14:28</span>
                      <span className="text-muted-foreground font-mono">/ 00:22:40</span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1"><Layers className="w-3 h-3 text-primary" /> 3 Lớp Xử Lý</span>
                      <span className="flex items-center gap-1"><Volume2 className="w-3 h-3 text-indigo-500" /> BGM + Voiceover</span>
                    </div>
                  </div>

                  {/* Tracks */}
                  <div className="relative h-20 rounded-xl bg-background border border-border/80 overflow-hidden flex flex-col justify-around p-1.5">
                    {/* Scrub Head Indicator */}
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-primary z-20 shadow-[0_0_8px_rgba(59,130,246,0.8)] transition-all pointer-events-none"
                      style={{ left: `${progress}%` }}
                    >
                      <div className="w-2.5 h-2.5 -ml-1 -mt-0.5 rounded-full bg-primary border-2 border-background" />
                    </div>

                    {/* Track 1: Video Cuts */}
                    <div className="relative h-5 rounded-md bg-muted/50 flex items-center px-2 gap-1 overflow-hidden">
                      <span className="text-[9px] font-mono font-bold text-muted-foreground shrink-0 mr-1">VIDEO</span>
                      <div className="h-3 w-1/5 rounded bg-blue-500/30 border border-blue-500/40 text-[8px] font-mono flex items-center px-1 text-blue-600 dark:text-blue-300">Cảnh 1</div>
                      <div className="h-3 w-1/4 rounded bg-blue-500/40 border border-blue-500/50 text-[8px] font-mono flex items-center px-1 text-blue-600 dark:text-blue-300">Cảnh 2</div>
                      <div className="h-3 w-1/3 rounded bg-primary/30 border border-primary/50 text-[8px] font-mono flex items-center px-1 text-primary">Cảnh 3 (Active)</div>
                      <div className="h-3 w-1/5 rounded bg-blue-500/20 border border-blue-500/30 text-[8px] font-mono flex items-center px-1 text-blue-600 dark:text-blue-300">Cảnh 4</div>
                    </div>

                    {/* Track 2: Audio Voiceover Waveform */}
                    <div className="relative h-5 rounded-md bg-muted/50 flex items-center px-2 gap-1 overflow-hidden">
                      <span className="text-[9px] font-mono font-bold text-indigo-500 shrink-0 mr-1">VOICE</span>
                      <div className="flex-1 flex items-center gap-0.5 h-3">
                        {Array.from({ length: 48 }).map((_, i) => (
                          <div
                            key={i}
                            className="w-1 bg-indigo-500/60 rounded-full transition-all"
                            style={{
                              height: `${Math.max(20, Math.sin(i * 0.45 + progress * 0.2) * 80 + 30)}%`,
                            }}
                          />
                        ))}
                      </div>
                    </div>

                    {/* Track 3: Subtitles */}
                    <div className="relative h-5 rounded-md bg-muted/50 flex items-center px-2 gap-1 overflow-hidden">
                      <span className="text-[9px] font-mono font-bold text-cyan-600 dark:text-cyan-400 shrink-0 mr-1">PHỤ ĐỀ</span>
                      <div className="h-3 w-1/3 rounded bg-cyan-500/25 border border-cyan-500/40 text-[8px] font-mono flex items-center px-1 text-cyan-700 dark:text-cyan-300 truncate">
                        Lời bình khớp nhịp cảnh
                      </div>
                      <div className="h-3 w-1/4 rounded bg-cyan-500/20 border border-cyan-500/30 text-[8px] font-mono flex items-center px-1 text-cyan-700 dark:text-cyan-300 truncate">
                        Hiệu ứng từ ngữ
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="dubbing-mode"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.25 }}
                className="space-y-5"
              >
                {/* Dubbing Dual Track Comparison */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Original Foreign Track */}
                  <div className="p-4 sm:p-5 rounded-xl sm:rounded-2xl bg-muted/30 border border-border/70 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                        <Volume2 className="w-4 h-4 text-amber-500" />
                        <span>Âm Thanh &amp; Phụ Đề Gốc (Tiếng Anh)</span>
                      </div>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-muted text-muted-foreground">
                        OCR + Whisper STT
                      </span>
                    </div>

                    <div className="p-3 rounded-xl bg-background/80 border border-border/70">
                      <p className="text-[11px] font-mono text-muted-foreground">[00:03:24 - 00:03:29]</p>
                      <p className="text-sm font-medium text-foreground mt-1">
                        &ldquo;We must proceed into the unknown sector before sunrise.&rdquo;
                      </p>
                    </div>

                    {/* Original Waveform */}
                    <div className="flex items-center gap-0.5 h-8 px-2 rounded-lg bg-background/50 border border-border/50">
                      {Array.from({ length: 36 }).map((_, i) => (
                        <div
                          key={i}
                          className="flex-1 bg-amber-500/50 rounded-full"
                          style={{
                            height: `${Math.max(15, Math.abs(Math.sin(i * 0.5)) * 90)}%`,
                          }}
                        />
                      ))}
                    </div>
                  </div>

                  {/* AI Synchronized Vietnamese Dubbed Track */}
                  <div className="p-4 sm:p-5 rounded-xl sm:rounded-2xl bg-primary/5 border border-primary/20 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="inline-flex items-center gap-2 text-xs font-semibold text-primary">
                        <Sparkles className="w-4 h-4" />
                        <span>Bản Lồng Tiếng AI (Tiếng Việt Chuẩn Nhịp)</span>
                      </div>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-primary/10 text-primary font-semibold">
                        Đồng bộ âm tiết 99.8%
                      </span>
                    </div>

                    <div className="p-3 rounded-xl bg-background/90 border border-primary/25 shadow-xs">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-mono text-primary font-semibold">[00:03:24 - 00:03:29]</span>
                        <span className="text-[10px] text-muted-foreground font-medium">Phong cách: Kịch Tính / Điện Ảnh</span>
                      </div>
                      <p className="text-sm font-semibold text-foreground mt-1">
                        &ldquo;Chúng ta phải tiến vào khu vực chưa ai từng biết tới trước lúc rạng đông.&rdquo;
                      </p>
                    </div>

                    {/* Synthesized Waveform */}
                    <div className="flex items-center gap-0.5 h-8 px-2 rounded-lg bg-background/50 border border-primary/20">
                      {Array.from({ length: 36 }).map((_, i) => (
                        <div
                          key={i}
                          className="flex-1 bg-primary rounded-full transition-all"
                          style={{
                            height: `${Math.max(20, Math.sin(i * 0.4 + progress * 0.3) * 85 + 25)}%`,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                {/* 13 Translation Styles & Engine Controls */}
                <div className="p-4 rounded-xl sm:rounded-2xl bg-muted/40 border border-border/70 flex flex-wrap items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                      <Sliders className="w-3.5 h-3.5 text-primary" />
                      <span>13 Phong Cách Biên Dịch &amp; Đa Giọng Đọc</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      {['Văn Học / Kịch Tính', 'Hài Hước / Bắt Trend', 'Tài Liệu / Khoa Học', 'Điện Ảnh Hollywood', 'Thương Mại / Review'].map((style, idx) => (
                        <span
                          key={style}
                          className={`text-[10px] px-2.5 py-1 rounded-md font-medium transition-colors ${
                            idx === 0
                              ? 'bg-primary text-primary-foreground font-semibold'
                              : 'bg-background border border-border/70 text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {style}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <div className="px-3 py-1.5 rounded-lg bg-background border border-border/80 text-xs font-mono">
                      <span className="text-muted-foreground">TTS Speed: </span>
                      <span className="text-foreground font-semibold">1.02x (Tự co giãn nhịp)</span>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Bottom Micro-Spec Banner */}
        <div className="px-4 sm:px-6 py-2.5 border-t border-border/60 bg-muted/20 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <Clock className="w-3 h-3 text-primary" />
            <span>Tự động phân đoạn video thành các chunk độc lập, xử lý song song tốc độ cao.</span>
          </div>
          <div className="flex items-center gap-2 font-mono text-[10px]">
            <Subtitles className="w-3 h-3 text-muted-foreground" />
            <span>OCR Phụ Đề Cứng • Khử Nhiễu mượt mà</span>
          </div>
        </div>
      </div>
    </div>
  );
}
