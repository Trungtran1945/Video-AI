import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles, Zap, ArrowRight, Play, CheckCircle2, Shield, Lock, Radio, Cpu
} from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';
import { ThemeToggle } from '@/components/ThemeToggle';
import HeroAnimation from '@/components/HeroAnimation';
import HeroStudioPreview from '@/components/HeroStudioPreview';
import WorkflowPipeline from '@/components/WorkflowPipeline';
import HorizontalFeatureShowcase from '@/components/HorizontalFeatureShowcase';
import Mini3DCardBackground from '@/components/Mini3DCardBackground';

export default function Landing() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const startNow = () => {
    navigate(isAuthenticated ? '/dashboard' : '/register');
  };

  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-hidden selection:bg-primary/20 selection:text-primary relative">
      
      {/* Navigation */}
      <nav className="fixed top-0 inset-x-0 z-50 backdrop-blur-xl bg-background/80 border-b border-border/70 transition-colors">
        <div className="max-w-7xl mx-auto flex items-center justify-between h-16 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 via-indigo-600 to-sky-500 flex items-center justify-center shadow-md shadow-blue-500/25 ring-1 ring-white/20">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <span className="font-bold text-foreground text-base tracking-tight">AI Shorts Factory</span>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-8 text-sm font-semibold text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors">
              Tính năng
            </a>
            <a href="#how" className="hover:text-foreground transition-colors">
              Quy trình
            </a>
            <a href="#modes" className="hover:text-foreground transition-colors">
              Bảo mật & Hiệu năng
            </a>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <ThemeToggle variant="quick" />
            <button
              onClick={() => navigate('/login')}
              className="px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold text-foreground hover:bg-muted transition-colors"
            >
              Đăng nhập
            </button>
            <button
              onClick={() => navigate('/register')}
              className="px-4 py-2 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-xs sm:text-sm font-semibold transition-all shadow-sm shadow-primary/25 hover:shadow-md hover:shadow-primary/35 active:scale-[0.98]"
            >
              Đăng ký
            </button>
          </div>
        </div>
      </nav>

      {/* Hero Section with 3D Organic Blossom Background (Inspired by background.mp4) */}
      <section className="relative pt-32 sm:pt-36 pb-20 sm:pb-28 px-4 sm:px-6 lg:px-8 overflow-hidden">
        {/* Animated 3D WebGL Background Canvas & Grid */}
        <HeroAnimation />

        <div className="relative max-w-5xl mx-auto text-center z-10">
          
          {/* Eyebrow Badge with Pulse indicator */}
          <motion.div
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
            className="inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full bg-primary/10 border border-primary/25 text-primary text-xs font-semibold mb-6 shadow-xs backdrop-blur-md"
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            <span>Nền tảng sản xuất video AI tự động thế hệ mới</span>
          </motion.div>

          {/* Cinematic Headline */}
          <motion.h1
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.1, ease: 'easeOut' }}
            className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extrabold text-foreground tracking-tight leading-[1.12]"
          >
            Tạo Video Shorts &amp; Phim<br className="hidden sm:inline" />{' '}
            <span className="bg-gradient-to-r from-blue-500 via-indigo-500 to-cyan-400 bg-clip-text text-transparent text-gradient-sheen">
              bằng AI chỉ với một cú nhấp
            </span>
          </motion.h1>

          {/* Description */}
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.2, ease: 'easeOut' }}
            className="text-base sm:text-lg md:text-xl text-muted-foreground dark:text-slate-300 mt-6 max-w-2xl mx-auto leading-relaxed"
          >
            Tự động hóa hoàn toàn hai quy trình đỉnh cao: <strong className="text-foreground font-semibold">Review phim tự động</strong> (phim 2–3 tiếng thành video tóm tắt cuốn hút) và <strong className="text-foreground font-semibold">Dịch thuật &amp; Lồng tiếng</strong> (13 phong cách dịch cùng giọng lồng AI chuẩn nhịp).
          </motion.p>

          {/* CTA Buttons */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.3, ease: 'easeOut' }}
            className="flex flex-col sm:flex-row items-center justify-center gap-3.5 sm:gap-4 mt-8"
          >
            <button
              onClick={startNow}
              className="group w-full sm:w-auto flex items-center justify-center gap-2.5 px-7 py-3.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-sm sm:text-base transition-all shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/35 hover:-translate-y-0.5 active:translate-y-0"
            >
              <span>Tạo video đầu tiên</span>
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
            </button>
            <button
              onClick={() => navigate('/login')}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl border border-border/80 bg-card/70 hover:bg-accent hover:border-border text-foreground font-semibold text-sm sm:text-base transition-all backdrop-blur-sm"
            >
              <Play className="w-4 h-4 text-primary" />
              <span>Đăng nhập hệ thống</span>
            </button>
          </motion.div>

          {/* AI Video Production Engine Interactive Showcase */}
          <motion.div
            initial={{ opacity: 0, y: 28, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.55, delay: 0.4, ease: 'easeOut' }}
          >
            <HeroStudioPreview />
          </motion.div>
        </div>
      </section>

      {/* Horizontal Scroll Pinned Showcase: các khung di chuyển theo chiều ngang khi lăn chuột, chỉ tiếp tục cuộn dọc khi đã lăn hết, mỗi khung có 3D background */}
      <HorizontalFeatureShowcase onStart={startNow} />

      {/* How it works (Interactive AI Processing Pipeline) */}
      <section id="how" className="py-24 px-4 sm:px-6 lg:px-8 bg-muted/20 border-t border-border/60 relative">
        <div className="max-w-5xl mx-auto">
          <div className="text-center max-w-xl mx-auto mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-xs font-semibold text-primary mb-3">
              <Cpu className="w-3.5 h-3.5" />
              <span>Quy Trình Tự Động Hóa</span>
            </div>
            <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-foreground tracking-tight">
              Quy trình đơn giản, hiệu suất tối đa
            </h2>
            <p className="text-sm sm:text-base text-muted-foreground dark:text-slate-300 mt-3">
              Từ video thô đến sản phẩm hoàn chỉnh chỉ trong 5 bước tự động hóa.
            </p>
          </div>

          {/* Interactive Pipeline Visualizer Component */}
          <WorkflowPipeline />
        </div>
      </section>

      {/* Trust & Performance callout with 3D Card Backgrounds */}
      <section id="modes" className="py-24 px-4 sm:px-6 lg:px-8 border-t border-border/60 relative">
        <div className="max-w-5xl mx-auto">
          <div className="text-center max-w-xl mx-auto mb-14">
            <h2 className="text-2xl sm:text-3xl font-bold text-foreground tracking-tight">
              Hạ tầng vận hành vững chắc &amp; An toàn
            </h2>
            <p className="text-xs sm:text-sm text-muted-foreground dark:text-slate-300 mt-2">
              Đảm bảo tính liên tục của quy trình sản xuất video với độ tin cậy cấp doanh nghiệp.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-center">
            
            {/* Card 1: Bảo Mật */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.35 }}
              className="group relative p-6 rounded-3xl bg-card/85 dark:bg-card/75 border border-border/80 shadow-md hover:border-primary/50 transition-all backdrop-blur-xl overflow-hidden"
            >
              <Mini3DCardBackground
                shapeType="octahedron"
                color="blue"
                className="opacity-35 dark:opacity-55 group-hover:opacity-75 transition-opacity"
              />

              <div className="relative z-10">
                <div className="w-12 h-12 rounded-2xl bg-blue-500/10 text-blue-500 flex items-center justify-center mx-auto mb-3 border border-blue-500/20 group-hover:scale-105 transition-transform">
                  <Shield className="w-6 h-6" />
                </div>
                <div className="text-3xl font-extrabold text-foreground tracking-tight font-mono">100%</div>
                <div className="font-bold text-foreground text-sm mt-1">Bảo Mật Tuyệt Đối</div>
                <p className="text-xs sm:text-sm text-muted-foreground dark:text-slate-300 mt-1 leading-relaxed">
                  Bảo mật dữ liệu &amp; an toàn API Key với mã hóa AES-256 đầu cuối.
                </p>
                <div className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground dark:text-slate-400">
                  <Lock className="w-3 h-3 text-emerald-500" />
                  <span>Zero Data Leaks</span>
                </div>
              </div>
            </motion.div>

            {/* Card 2: SSE Realtime */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.08, duration: 0.35 }}
              className="group relative p-6 rounded-3xl bg-card/85 dark:bg-card/75 border border-border/80 shadow-md hover:border-primary/50 transition-all backdrop-blur-xl overflow-hidden"
            >
              <Mini3DCardBackground
                shapeType="rings"
                color="violet"
                className="opacity-35 dark:opacity-55 group-hover:opacity-75 transition-opacity"
              />

              <div className="relative z-10">
                <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center mx-auto mb-3 border border-indigo-500/20 group-hover:scale-105 transition-transform">
                  <Radio className="w-6 h-6" />
                </div>
                <div className="text-3xl font-extrabold text-foreground tracking-tight font-mono">Real-time</div>
                <div className="font-bold text-foreground text-sm mt-1">Truyền Tải Trực Tiếp</div>
                <p className="text-xs sm:text-sm text-muted-foreground dark:text-slate-300 mt-1 leading-relaxed">
                  Theo dõi tiến trình mượt mà từng giây qua kết nối Server-Sent Events.
                </p>
                <div className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground dark:text-slate-400">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span>SSE Stream Active</span>
                </div>
              </div>
            </motion.div>

            {/* Card 3: Auto Recovery */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.16, duration: 0.35 }}
              className="group relative p-6 rounded-3xl bg-card/85 dark:bg-card/75 border border-border/80 shadow-md hover:border-primary/50 transition-all backdrop-blur-xl overflow-hidden"
            >
              <Mini3DCardBackground
                shapeType="icosahedron"
                color="cyan"
                className="opacity-35 dark:opacity-55 group-hover:opacity-75 transition-opacity"
              />

              <div className="relative z-10">
                <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 text-cyan-500 flex items-center justify-center mx-auto mb-3 border border-cyan-500/20 group-hover:scale-105 transition-transform">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <div className="text-3xl font-extrabold text-foreground tracking-tight font-mono">Tự Động</div>
                <div className="font-bold text-foreground text-sm mt-1">Phục Hồi Thông Minh</div>
                <p className="text-xs sm:text-sm text-muted-foreground dark:text-slate-300 mt-1 leading-relaxed">
                  Hàng đợi xử lý thông minh, tự động lưu checkpoint và retry khi ngắt mạng.
                </p>
                <div className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground dark:text-slate-400">
                  <Zap className="w-3 h-3 text-amber-500" />
                  <span>Auto Retry Active</span>
                </div>
              </div>
            </motion.div>

          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-24 px-4 sm:px-6 lg:px-8 border-t border-border/60 relative">
        <div className="max-w-4xl mx-auto text-center relative">
          
          {/* Ambient Glow behind CTA Box */}
          <div className="absolute inset-0 bg-gradient-to-r from-blue-500/20 via-indigo-500/25 to-cyan-500/20 rounded-3xl blur-3xl opacity-60 pointer-events-none -z-10" />

          <div className="rounded-3xl bg-card/90 dark:bg-card/80 border border-primary/25 p-8 sm:p-14 shadow-2xl backdrop-blur-xl relative overflow-hidden">
            
            {/* Subtle decorative grid inside CTA */}
            <div className="absolute inset-0 bg-[radial-gradient(hsl(var(--primary)/0.12)_1px,transparent_1px)] bg-[size:2rem_2rem] opacity-40 pointer-events-none" />

            <div className="relative z-10">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-xs font-semibold text-primary mb-4">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Bắt Đầu Miễn Phí Ngay Hôm Nay</span>
              </div>

              <h2 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-extrabold text-foreground tracking-tight leading-tight">
                Sẵn sàng tạo video đầu tiên?
              </h2>

              <p className="text-sm sm:text-base md:text-lg text-muted-foreground dark:text-slate-200 mt-4 max-w-xl mx-auto leading-relaxed">
                Bắt đầu quy trình sản xuất video Shorts tự động ngay hôm nay. Tiết kiệm hàng giờ biên tập thủ công.
              </p>

              <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3.5">
                <button
                  onClick={startNow}
                  className="group w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-3.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-sm sm:text-base transition-all shadow-lg shadow-primary/30 hover:shadow-xl hover:shadow-primary/40 active:scale-[0.98]"
                >
                  <span>Bắt đầu ngay</span>
                  <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                </button>
                <button
                  onClick={() => navigate('/login')}
                  className="w-full sm:w-auto px-6 py-3.5 rounded-xl border border-border/80 bg-background/80 hover:bg-accent text-foreground font-semibold text-sm sm:text-base transition-colors"
                >
                  Đăng nhập tài khoản
                </button>
              </div>

              {/* Trust micro-badges */}
              <div className="mt-8 pt-6 border-t border-border/60 flex flex-wrap items-center justify-center gap-6 text-xs text-muted-foreground dark:text-slate-300">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                  Hỗ trợ tải tệp ≤2GB
                </span>
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                  Không cần cài đặt phần mềm
                </span>
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                  Xuất video Full HD sắc nét
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 border-t border-border/70 px-4 sm:px-6 lg:px-8 text-center text-xs sm:text-sm text-muted-foreground dark:text-slate-400 bg-background/60 backdrop-blur-md">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-lg bg-primary/20 text-primary flex items-center justify-center">
              <Sparkles className="w-3.5 h-3.5" />
            </div>
            <span>AI Shorts Factory — Nền tảng tự động hóa sản xuất video thông minh</span>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span>© 2026 AI Shorts Factory. All rights reserved.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}