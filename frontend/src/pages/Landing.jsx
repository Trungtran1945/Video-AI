import { useNavigate } from 'react-router-dom';
import {
  Film, ArrowRight, Play, CheckCircle2, Shield, Lock, Radio, Cpu
} from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';
import { ThemeToggle } from '@/components/ThemeToggle';
import HeroStudioPreview from '@/components/HeroStudioPreview';
import WorkflowPipeline from '@/components/WorkflowPipeline';
import HorizontalFeatureShowcase from '@/components/HorizontalFeatureShowcase';

export default function Landing() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const startNow = () => {
    navigate(isAuthenticated ? '/dashboard' : '/register');
  };

  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-hidden selection:bg-primary/20 selection:text-primary relative">
      
      {/* Navigation */}
      <nav className="fixed top-0 inset-x-0 z-50 backdrop-blur-md bg-background/80 border-b border-border transition-colors">
        <div className="max-w-6xl mx-auto flex items-center justify-between h-14 px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-secondary border border-border/80 flex items-center justify-center text-primary">
              <Film className="w-3.5 h-3.5" />
            </div>
            <div>
              <span className="font-medium text-foreground text-sm tracking-tight">AI Shorts Factory</span>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-6 text-xs text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors">
              Tính năng
            </a>
            <a href="#how" className="hover:text-foreground transition-colors">
              Quy trình
            </a>
            <a href="#modes" className="hover:text-foreground transition-colors">
              Hạ tầng
            </a>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <ThemeToggle variant="quick" />
            <button
              onClick={() => navigate('/login')}
              className="px-3 py-1.5 rounded-md text-xs font-normal text-foreground hover:bg-secondary border border-border transition-colors"
            >
              Đăng nhập
            </button>
            <button
              onClick={() => navigate('/register')}
              className="px-3 py-1.5 rounded-md bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-medium transition-colors"
            >
              Đăng ký
            </button>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative pt-28 sm:pt-32 pb-16 sm:pb-24 px-4 sm:px-6 overflow-hidden">
        <div className="relative max-w-5xl mx-auto text-center z-10">
          
          {/* Quiet Status Eyebrow */}
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-secondary border border-border text-xs text-muted-foreground mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
            <span>Nền tảng sản xuất video Shorts &amp; Lồng tiếng tự động</span>
          </div>

          {/* Solid Headline */}
          <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-medium text-foreground tracking-tight leading-[1.12]">
            Sản xuất Video Shorts &amp; Lồng tiếng Phim tự động
          </h1>

          {/* Description */}
          <p className="text-sm sm:text-base md:text-lg text-muted-foreground mt-4 max-w-2xl mx-auto leading-relaxed">
            Tự động hóa hoàn toàn hai quy trình chuyên sâu: Review phim từ video nguồn dài sang video ngắn súc tích, và Dịch thuật kèm lồng tiếng AI đồng bộ theo 13 phong cách biên tập.
          </p>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-7">
            <button
              onClick={startNow}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2.5 rounded-md bg-primary hover:bg-primary/90 text-primary-foreground font-medium text-xs sm:text-sm transition-colors"
            >
              <span>Khởi tạo dự án</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => navigate('/login')}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-4 py-2.5 rounded-md border border-border bg-secondary hover:bg-secondary/80 text-foreground font-normal text-xs sm:text-sm transition-colors"
            >
              <Play className="w-3.5 h-3.5 text-muted-foreground" />
              <span>Đăng nhập hệ thống</span>
            </button>
          </div>

          {/* Real Studio Preview */}
          <div>
            <HeroStudioPreview />
          </div>
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

      {/* Trust & Performance */}
      <section id="modes" className="py-20 px-4 sm:px-6 border-t border-border relative">
        <div className="max-w-5xl mx-auto">
          <div className="text-center max-w-xl mx-auto mb-12">
            <h2 className="text-xl sm:text-2xl font-medium text-foreground tracking-tight">
              Hạ tầng vận hành &amp; Độ tin cậy
            </h2>
            <p className="text-xs sm:text-sm text-muted-foreground mt-2">
              Đảm bảo tính liên tục của quy trình sản xuất video với độ ổn định cao.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 text-left">
            {/* Card 1: Bảo Mật */}
            <div className="p-5 rounded-xl bg-card border border-border">
              <div className="w-9 h-9 rounded-lg bg-secondary text-foreground flex items-center justify-center mb-4 border border-border">
                <Shield className="w-4 h-4 text-primary" />
              </div>
              <div className="text-2xl font-medium text-foreground tracking-tight font-mono tabular-nums">100%</div>
              <div className="font-medium text-foreground text-sm mt-1">Bảo mật API Key</div>
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                Tất cả khóa kết nối nhà cung cấp được mã hóa an toàn ở mức lưu trữ hệ thống.
              </p>
              <div className="mt-4 pt-3 border-t border-border/60 flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
                <Lock className="w-3 h-3 text-emerald-500" />
                <span>Mã hóa AES-256</span>
              </div>
            </div>

            {/* Card 2: SSE Realtime */}
            <div className="p-5 rounded-xl bg-card border border-border">
              <div className="w-9 h-9 rounded-lg bg-secondary text-foreground flex items-center justify-center mb-4 border border-border">
                <Radio className="w-4 h-4 text-primary" />
              </div>
              <div className="text-2xl font-medium text-foreground tracking-tight font-mono">Real-time</div>
              <div className="font-medium text-foreground text-sm mt-1">Truyền tải sự kiện SSE</div>
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                Cập nhật từng giai đoạn pipeline và tiến độ render trực tiếp không cần tải lại trang.
              </p>
              <div className="mt-4 pt-3 border-t border-border/60 flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                <span>SSE Stream Active</span>
              </div>
            </div>

            {/* Card 3: Auto Recovery */}
            <div className="p-5 rounded-xl bg-card border border-border">
              <div className="w-9 h-9 rounded-lg bg-secondary text-foreground flex items-center justify-center mb-4 border border-border">
                <CheckCircle2 className="w-4 h-4 text-primary" />
              </div>
              <div className="text-2xl font-medium text-foreground tracking-tight font-mono">Tự động</div>
              <div className="font-medium text-foreground text-sm mt-1">Khôi phục phiên tải lên</div>
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                Giao thức tải tệp theo chunk cho phép tiếp tục tải khi đường truyền gián đoạn.
              </p>
              <div className="mt-4 pt-3 border-t border-border/60 flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
                <Cpu className="w-3 h-3 text-primary" />
                <span>Resumable Chunks</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-4 sm:px-6 border-t border-border relative">
        <div className="max-w-4xl mx-auto text-center">
          <div className="rounded-xl bg-card border border-border p-8 sm:p-12">
            <h2 className="text-xl sm:text-2xl md:text-3xl font-medium text-foreground tracking-tight">
              Sẵn sàng tạo video đầu tiên?
            </h2>

            <p className="text-xs sm:text-sm md:text-base text-muted-foreground mt-3 max-w-xl mx-auto leading-relaxed">
              Khởi chạy pipeline tự động hóa quy trình sản xuất video Shorts và tóm tắt phim ngay bây giờ.
            </p>

            <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                onClick={startNow}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-md bg-primary hover:bg-primary/90 text-primary-foreground font-medium text-xs sm:text-sm transition-colors"
              >
                <span>Bắt đầu ngay</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => navigate('/login')}
                className="w-full sm:w-auto px-5 py-2.5 rounded-md border border-border bg-secondary hover:bg-secondary/80 text-foreground font-normal text-xs sm:text-sm transition-colors"
              >
                Đăng nhập tài khoản
              </button>
            </div>

            {/* Trust micro-badges */}
            <div className="mt-6 pt-5 border-t border-border/60 flex flex-wrap items-center justify-center gap-6 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                Hỗ trợ tệp video ≤2GB
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                Không cần cài đặt ứng dụng
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                Độ phân giải 1080p
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-6 border-t border-border px-4 sm:px-6 text-xs text-muted-foreground bg-background">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Film className="w-3.5 h-3.5 text-primary" />
            <span>AI Shorts Factory — Studio sản xuất video tự động</span>
          </div>
          <div className="flex items-center gap-4">
            <span>© 2026 AI Shorts Factory.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}