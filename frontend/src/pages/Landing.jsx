import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles, Zap, Globe, ArrowRight, Play, Languages, Clapperboard,
  CheckCircle2, Film, AudioLines, ChevronRight, Shield
} from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';
import { ThemeToggle } from '@/components/ThemeToggle';
import HeroAnimation from '@/components/HeroAnimation';

const features = [
  {
    icon: Clapperboard,
    title: 'Review Phim Tự Động',
    desc: 'Tải phim 2–3 tiếng, AI tự động phát hiện cảnh quan trọng, tóm tắt cốt truyện và xuất video review 20–30 phút sẵn sàng đăng tải.',
    tag: 'Pipeline Thông Minh',
  },
  {
    icon: Languages,
    title: 'Dịch Thuật & Lồng Tiếng',
    desc: 'Tải video nước ngoài, AI dịch tiếng Việt theo 13 phong cách biên dịch chuyên nghiệp và lồng giọng AI đồng bộ thời gian chuẩn xác.',
    tag: '13 Phong Cách',
  },
  {
    icon: Zap,
    title: 'Pipeline Nền Tốc Độ Cao',
    desc: 'Hàng đợi thông minh tự phân tải, tự động thử lại khi lỗi rate limit, theo dõi tiến trình trực tiếp theo thời gian thực qua SSE.',
    tag: 'Real-time SSE',
  },
  {
    icon: Globe,
    title: 'Đa Ngôn Ngữ & Đa Giọng Đọc',
    desc: 'Hỗ trợ hơn 8 ngôn ngữ nguồn với thư viện giọng đọc tự nhiên chuẩn sắc thái, cảm xúc và ngữ điệu từng vùng miền.',
    tag: 'Edge / ElevenLabs',
  },
];

const workflowSteps = [
  { num: '01', title: 'Chọn chế độ sản xuất', desc: 'Chọn chế độ Review phim dài hoặc Dịch thuật & Lồng tiếng video ngoại ngữ.' },
  { num: '02', title: 'Tải lên video nguồn', desc: 'Hỗ trợ tải video dung lượng tới 2GB với cơ chế chunking tự khôi phục khi ngắt kết nối.' },
  { num: '03', title: 'Tùy chỉnh phong cách', desc: 'Chọn ngôn ngữ đích, 13 phong cách dịch văn học, giọng đọc AI và bật/tắt nhận dạng OCR.' },
  { num: '04', title: 'AI xử lý tự động', desc: 'Hệ thống tự động chạy chuỗi: tách lời thoại, dịch kịch bản, sinh audio và biên tập khung hình.' },
  { num: '05', title: 'Kiểm duyệt & xuất bản', desc: 'Theo dõi tiến độ thời gian thực, chỉnh sửa timeline trực quan và tải video thành phẩm sắc nét.' },
];

export default function Landing() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const startNow = () => {
    navigate(isAuthenticated ? '/dashboard' : '/register');
  };

  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-hidden selection:bg-primary/20 selection:text-primary">
      {/* Navigation */}
      <nav className="fixed top-0 inset-x-0 z-50 backdrop-blur-xl bg-background/80 border-b border-border/70 transition-colors">
        <div className="max-w-7xl mx-auto flex items-center justify-between h-16 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-md shadow-blue-500/20">
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

          <div className="flex items-center gap-2.5 sm:gap-3">
            <ThemeToggle variant="quick" />
            <button
              onClick={() => navigate('/login')}
              className="px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold text-foreground hover:bg-muted transition-colors"
            >
              Đăng nhập
            </button>
            <button
              onClick={() => navigate('/register')}
              className="px-4 py-2 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-xs sm:text-sm font-semibold transition-all shadow-sm shadow-primary/25"
            >
              Đăng ký
            </button>
          </div>
        </div>
      </nav>

      {/* Hero Section with Animated Background */}
      <section className="relative pt-32 sm:pt-36 pb-20 sm:pb-28 px-4 sm:px-6 lg:px-8">
        <HeroAnimation />

        <div className="relative max-w-5xl mx-auto text-center z-10">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-semibold mb-6 shadow-xs"
          >
            <Sparkles className="w-3.5 h-3.5 shrink-0" />
            <span>Nền tảng sản xuất video AI tự động thế hệ mới</span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
            className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extrabold text-foreground tracking-tight leading-[1.1]"
          >
            Tạo Video Shorts &amp; Phim<br className="hidden sm:inline" />
            <span className="bg-gradient-to-r from-blue-500 via-indigo-500 to-sky-500 bg-clip-text text-transparent">
              bằng AI chỉ với một cú nhấp
            </span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.2 }}
            className="text-base sm:text-lg md:text-xl text-muted-foreground mt-6 max-w-2xl mx-auto leading-relaxed"
          >
            Tự động hóa hoàn toàn hai quy trình đỉnh cao: <strong className="text-foreground font-semibold">Review phim tự động</strong> (phim 2–3 tiếng thành video tóm tắt cuốn hút) và <strong className="text-foreground font-semibold">Dịch thuật &amp; Lồng tiếng</strong> (13 phong cách dịch cùng giọng lồng AI chuẩn nhịp).
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.3 }}
            className="flex flex-col sm:flex-row items-center justify-center gap-3.5 sm:gap-4 mt-8"
          >
            <button
              onClick={startNow}
              className="w-full sm:w-auto flex items-center justify-center gap-2.5 px-7 py-3.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-sm sm:text-base transition-all shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30"
            >
              <span>Tạo video đầu tiên</span>
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => navigate('/login')}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl border border-border bg-card/70 hover:bg-accent text-foreground font-semibold text-sm sm:text-base transition-colors"
            >
              <Play className="w-4 h-4 text-primary" />
              <span>Đăng nhập hệ thống</span>
            </button>
          </motion.div>

          {/* Interactive Feature Teaser Card */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.4 }}
            className="mt-14 max-w-4xl mx-auto rounded-2xl sm:rounded-3xl bg-card/80 border border-border/80 p-4 sm:p-6 shadow-2xl backdrop-blur-md"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-left">
              <div className="p-5 rounded-2xl bg-muted/40 border border-border/60 hover:border-primary/30 transition-colors">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center mb-3">
                  <Film className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-foreground text-sm sm:text-base">Chế độ Review Phim</h3>
                <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 leading-relaxed">
                  Nhận diện nhịp cảnh, viết kịch bản tóm tắt lôi cuốn, tạo giọng bình luận khớp chính xác với hình ảnh.
                </p>
                <div className="mt-4 flex items-center gap-2 text-xs font-semibold text-primary">
                  <span>Xem chi tiết luồng xử lý</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </div>
              </div>

              <div className="p-5 rounded-2xl bg-muted/40 border border-border/60 hover:border-primary/30 transition-colors">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mb-3">
                  <AudioLines className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-foreground text-sm sm:text-base">Dịch &amp; Lồng Tiếng Chuẩn Nhịp</h3>
                <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 leading-relaxed">
                  Trích xuất audio, OCR phụ đề cứng, dịch sang tiếng Việt tự nhiên theo 13 phong cách và ghép lồng tiếng hoàn hảo.
                </p>
                <div className="mt-4 flex items-center gap-2 text-xs font-semibold text-primary">
                  <span>Hỗ trợ tải tệp ≤2GB</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Features Grid */}
      <section id="features" className="py-20 px-4 sm:px-6 lg:px-8 border-t border-border/50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center max-w-2xl mx-auto mb-14">
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
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.08 }}
                  className="rounded-2xl bg-card border border-border p-6 hover:border-primary/30 hover:shadow-lg transition-all flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <div className="w-11 h-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                        <Icon className="w-5 h-5" />
                      </div>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-muted text-muted-foreground uppercase tracking-wider">
                        {f.tag}
                      </span>
                    </div>
                    <h3 className="font-bold text-foreground text-base">{f.title}</h3>
                    <p className="text-xs sm:text-sm text-muted-foreground mt-2 leading-relaxed">{f.desc}</p>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="py-20 px-4 sm:px-6 lg:px-8 bg-muted/25 border-t border-border/50">
        <div className="max-w-4xl mx-auto">
          <div className="text-center max-w-xl mx-auto mb-14">
            <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-foreground tracking-tight">
              Quy trình đơn giản, hiệu suất tối đa
            </h2>
            <p className="text-sm sm:text-base text-muted-foreground mt-3">
              Từ video thô đến sản phẩm hoàn chỉnh chỉ trong 5 bước tự động hóa.
            </p>
          </div>

          <div className="space-y-3.5">
            {workflowSteps.map((s, i) => (
              <motion.div
                key={s.num}
                initial={{ opacity: 0, x: -16 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.06 }}
                className="flex items-center gap-4 sm:gap-6 p-4 sm:p-5 rounded-2xl bg-card border border-border hover:border-primary/30 transition-all shadow-xs"
              >
                <div className="text-xl sm:text-2xl font-extrabold text-primary/40 font-mono w-10 sm:w-12 shrink-0">
                  {s.num}
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm sm:text-base font-semibold text-foreground">{s.title}</h4>
                  <p className="text-xs sm:text-sm text-muted-foreground mt-0.5 leading-relaxed">{s.desc}</p>
                </div>
                {i < workflowSteps.length - 1 && (
                  <ArrowRight className="w-4 h-4 text-muted-foreground/50 ml-auto hidden sm:block shrink-0" />
                )}
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Trust & Performance callout */}
      <section id="modes" className="py-20 px-4 sm:px-6 lg:px-8 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-center">
            <div className="p-6 rounded-2xl bg-card border border-border">
              <Shield className="w-8 h-8 text-primary mx-auto mb-3" />
              <div className="text-2xl font-bold text-foreground">100%</div>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1">Bảo mật dữ liệu &amp; an toàn API Key</p>
            </div>
            <div className="p-6 rounded-2xl bg-card border border-border">
              <Zap className="w-8 h-8 text-primary mx-auto mb-3" />
              <div className="text-2xl font-bold text-foreground">Real-time</div>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1">Theo dõi tiến trình mượt mà qua SSE</p>
            </div>
            <div className="p-6 rounded-2xl bg-card border border-border">
              <CheckCircle2 className="w-8 h-8 text-primary mx-auto mb-3" />
              <div className="text-2xl font-bold text-foreground">Tự Động</div>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1">Hàng đợi xử lý thông minh &amp; tự phục hồi</p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 border-t border-border/50">
        <div className="max-w-3xl mx-auto text-center">
          <div className="rounded-3xl bg-gradient-to-br from-primary/15 via-primary/5 to-transparent border border-primary/20 p-8 sm:p-12 shadow-xl">
            <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-foreground tracking-tight">
              Sẵn sàng tạo video đầu tiên?
            </h2>
            <p className="text-sm sm:text-base text-muted-foreground mt-3 max-w-xl mx-auto leading-relaxed">
              Bắt đầu quy trình sản xuất video Shorts tự động ngay hôm nay. Tiết kiệm hàng giờ biên tập thủ công.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3.5">
              <button
                onClick={startNow}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-sm sm:text-base transition-all shadow-lg shadow-primary/25"
              >
                <span>Bắt đầu ngay</span>
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                onClick={() => navigate('/login')}
                className="w-full sm:w-auto px-6 py-3.5 rounded-xl border border-border bg-card hover:bg-accent text-foreground font-semibold text-sm sm:text-base transition-colors"
              >
                Đăng nhập tài khoản
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 border-t border-border px-4 sm:px-6 lg:px-8 text-center text-xs sm:text-sm text-muted-foreground">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            AI Shorts Factory — Nền tảng tự động hóa sản xuất video thông minh
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span>© 2026 AI Shorts Factory</span>
          </div>
        </div>
      </footer>
    </div>
  );
}