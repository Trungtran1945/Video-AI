import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles, Zap, Globe, ArrowRight, Play, Languages, Clapperboard,
  CheckCircle2, Shield, Lock, Radio, Cpu
} from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';
import { ThemeToggle } from '@/components/ThemeToggle';
import HeroAnimation from '@/components/HeroAnimation';
import HeroStudioPreview from '@/components/HeroStudioPreview';
import WorkflowPipeline from '@/components/WorkflowPipeline';

const features = [
  {
    icon: Clapperboard,
    title: 'Review Phim Tự Động',
    desc: 'Tải phim 2–3 tiếng, AI tự động phát hiện cảnh quan trọng, tóm tắt cốt truyện và xuất video review 20–30 phút sẵn sàng đăng tải.',
    tag: 'Pipeline Thông Minh',
    color: 'from-blue-500/20 to-indigo-500/10',
    iconColor: 'text-blue-500 dark:text-blue-400',
    accentBorder: 'group-hover:border-blue-500/40',
  },
  {
    icon: Languages,
    title: 'Dịch Thuật & Lồng Tiếng',
    desc: 'Tải video nước ngoài, AI dịch tiếng Việt theo 13 phong cách biên dịch chuyên nghiệp và lồng giọng AI đồng bộ thời gian chuẩn xác.',
    tag: '13 Phong Cách',
    color: 'from-indigo-500/20 to-violet-500/10',
    iconColor: 'text-indigo-500 dark:text-indigo-400',
    accentBorder: 'group-hover:border-indigo-500/40',
  },
  {
    icon: Zap,
    title: 'Pipeline Nền Tốc Độ Cao',
    desc: 'Hàng đợi thông minh tự phân tải, tự động thử lại khi lỗi rate limit, theo dõi tiến trình trực tiếp theo thời gian thực qua SSE.',
    tag: 'Real-time SSE',
    color: 'from-sky-500/20 to-blue-500/10',
    iconColor: 'text-sky-500 dark:text-sky-400',
    accentBorder: 'group-hover:border-sky-500/40',
  },
  {
    icon: Globe,
    title: 'Đa Ngôn Ngữ & Đa Giọng Đọc',
    desc: 'Hỗ trợ hơn 8 ngôn ngữ nguồn với thư viện giọng đọc tự nhiên chuẩn sắc thái, cảm xúc và ngữ điệu từng vùng miền.',
    tag: 'Edge / ElevenLabs',
    color: 'from-purple-500/20 to-indigo-500/10',
    iconColor: 'text-purple-500 dark:text-purple-400',
    accentBorder: 'group-hover:border-purple-500/40',
  },
];

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

          <div className="hidden md:flex items-center gap-8 text-sm font-medium text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors">
              Tính năng
            </a>
            <a href="#how" className="hover:text-foreground transition-colors">
              Quy trình
            </a>
            <a href="#modes" className="hover:text-foreground transition-colors">
              Chế độ tạo
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

      {/* Hero Section with Multi-layer Animated Background */}
      <section className="relative pt-32 sm:pt-36 pb-20 sm:pb-28 px-4 sm:px-6 lg:px-8 overflow-hidden">
        {/* Animated Background Canvas & Grid */}
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
            className="text-base sm:text-lg md:text-xl text-muted-foreground mt-6 max-w-2xl mx-auto leading-relaxed"
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

      {/* Features Grid */}
      <section id="features" className="py-24 px-4 sm:px-6 lg:px-8 border-t border-border/60 relative">
        {/* Subtle Ambient Light Blob behind section */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-5xl h-72 bg-gradient-to-r from-blue-500/5 via-indigo-500/5 to-cyan-500/5 blur-3xl pointer-events-none -z-10" />

        <div className="max-w-6xl mx-auto">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-muted/80 border border-border/70 text-xs font-semibold text-primary mb-3">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Công Nghệ Đột Phá</span>
            </div>
            <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-foreground tracking-tight">
              Mọi công cụ bạn cần trong một nền tảng
            </h2>
            <p className="text-sm sm:text-base text-muted-foreground mt-3 leading-relaxed">
              Kiến trúc mở đa nhà cung cấp với khả năng dự phòng thông minh, tốc độ cao và tối ưu chi phí.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {features.map((f, i) => {
              const Icon = f.icon;
              return (
                <motion.div
                  key={f.title}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.08, duration: 0.4 }}
                  whileHover={{ y: -4, transition: { duration: 0.2 } }}
                  className={`group relative rounded-2xl bg-card/85 dark:bg-card/75 border border-border/80 p-6 transition-all flex flex-col justify-between shadow-xs hover:shadow-xl hover:shadow-primary/5 ${f.accentBorder} backdrop-blur-sm`}
                >
                  {/* Subtle hover gradient wash */}
                  <div className={`absolute inset-0 rounded-2xl bg-gradient-to-br ${f.color} opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none -z-0`} />

                  <div className="relative z-10">
                    <div className="flex items-center justify-between mb-4">
                      <div className={`w-11 h-11 rounded-xl bg-muted/80 border border-border/60 ${f.iconColor} flex items-center justify-center transition-transform group-hover:scale-105`}>
                        <Icon className="w-5 h-5" />
                      </div>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-muted text-muted-foreground uppercase tracking-wider font-mono">
                        {f.tag}
                      </span>
                    </div>
                    <h3 className="font-bold text-foreground text-base group-hover:text-primary transition-colors">
                      {f.title}
                    </h3>
                    <p className="text-xs sm:text-sm text-muted-foreground mt-2 leading-relaxed">
                      {f.desc}
                    </p>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

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
            <p className="text-sm sm:text-base text-muted-foreground mt-3">
              Từ video thô đến sản phẩm hoàn chỉnh chỉ trong 5 bước tự động hóa.
            </p>
          </div>

          {/* Interactive Pipeline Visualizer Component */}
          <WorkflowPipeline />
        </div>
      </section>

      {/* Trust & Performance callout */}
      <section id="modes" className="py-24 px-4 sm:px-6 lg:px-8 border-t border-border/60 relative">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-center">
            
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.35 }}
              className="p-6 rounded-2xl bg-card/85 dark:bg-card/75 border border-border/80 shadow-xs hover:border-primary/40 transition-colors backdrop-blur-sm"
            >
              <div className="w-12 h-12 rounded-xl bg-blue-500/10 text-blue-500 flex items-center justify-center mx-auto mb-3">
                <Shield className="w-6 h-6" />
              </div>
              <div className="text-3xl font-extrabold text-foreground tracking-tight font-mono">100%</div>
              <div className="font-semibold text-foreground text-sm mt-1">Bảo Mật Tuyệt Đối</div>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1 leading-relaxed">
                Bảo mật dữ liệu &amp; an toàn API Key với mã hóa AES-256 đầu cuối.
              </p>
              <div className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
                <Lock className="w-3 h-3 text-emerald-500" />
                <span>Zero Data Leaks</span>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.08, duration: 0.35 }}
              className="p-6 rounded-2xl bg-card/85 dark:bg-card/75 border border-border/80 shadow-xs hover:border-primary/40 transition-colors backdrop-blur-sm"
            >
              <div className="w-12 h-12 rounded-xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center mx-auto mb-3">
                <Radio className="w-6 h-6" />
              </div>
              <div className="text-3xl font-extrabold text-foreground tracking-tight font-mono">Real-time</div>
              <div className="font-semibold text-foreground text-sm mt-1">Truyền Tải Trực Tiếp</div>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1 leading-relaxed">
                Theo dõi tiến trình mượt mà từng giây qua kết nối Server-Sent Events.
              </p>
              <div className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span>SSE Stream Active</span>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.16, duration: 0.35 }}
              className="p-6 rounded-2xl bg-card/85 dark:bg-card/75 border border-border/80 shadow-xs hover:border-primary/40 transition-colors backdrop-blur-sm"
            >
              <div className="w-12 h-12 rounded-xl bg-cyan-500/10 text-cyan-500 flex items-center justify-center mx-auto mb-3">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div className="text-3xl font-extrabold text-foreground tracking-tight font-mono">Tự Động</div>
              <div className="font-semibold text-foreground text-sm mt-1">Phục Hồi Thông Minh</div>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1 leading-relaxed">
                Hàng đợi xử lý thông minh, tự động lưu checkpoint và retry khi ngắt mạng.
              </p>
              <div className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
                <Zap className="w-3 h-3 text-amber-500" />
                <span>Auto Retry Active</span>
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

              <p className="text-sm sm:text-base md:text-lg text-muted-foreground mt-4 max-w-xl mx-auto leading-relaxed">
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
              <div className="mt-8 pt-6 border-t border-border/60 flex flex-wrap items-center justify-center gap-6 text-xs text-muted-foreground">
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
      <footer className="py-8 border-t border-border/70 px-4 sm:px-6 lg:px-8 text-center text-xs sm:text-sm text-muted-foreground bg-background/60 backdrop-blur-md">
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