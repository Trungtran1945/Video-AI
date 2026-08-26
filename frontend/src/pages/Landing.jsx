import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Zap, Globe, ArrowRight, Play, Languages, Clapperboard } from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';

const features = [
  { icon: Clapperboard, title: 'Review Phim Tự Động', desc: 'Tải phim 2–3 tiếng, AI cắt cảnh và viết lời review thành video 20–30 phút.' },
  { icon: Languages, title: 'Dịch Thuật & Lồng Tiếng', desc: 'Tải video nước ngoài có phụ đề cứng, AI dịch tiếng Việt theo 12 phong cách và lồng giọng AI ép khớp thời gian.' },
  { icon: Zap, title: 'Pipeline Nền', desc: 'Hàng đợi thông minh, tự động thử lại, tiến trình real-time qua SSE.' },
  { icon: Globe, title: 'Đa Ngôn Ngữ', desc: 'Hỗ trợ 8+ ngôn ngữ với giọng nói tự nhiên.' },
];

const modes = [
  { num: '01', label: 'Chọn chế độ: Review phim / Dịch & Lồng tiếng' },
  { num: '02', label: 'Upload phim hoặc video nước ngoài (resumable ≤2GB)' },
  { num: '03', label: 'Chọn ngôn ngữ, phong cách dịch, bật/tắt lồng tiếng' },
  { num: '04', label: 'AI chạy pipeline tự động (STT + OCR song song)' },
  { num: '05', label: 'Xem tiến trình realtime & video đầu ra' },
];

export default function Landing() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const startNow = () => {
    navigate(isAuthenticated ? '/dashboard' : '/register');
  };

  return (
    <div className="min-h-screen bg-[#0F1117] text-slate-200 overflow-x-hidden">
      {/* Nav */}
      <nav className="fixed top-0 inset-x-0 z-50 backdrop-blur-xl bg-[#0F1117]/80 border-b border-white/5">
        <div className="max-w-7xl mx-auto flex items-center justify-between h-16 px-6">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-white">AI Shorts Factory</span>
          </div>
          <div className="hidden md:flex items-center gap-8 text-sm text-slate-400">
            <a href="#features" className="hover:text-white transition">Tính năng</a>
            <a href="#how" className="hover:text-white transition">Cách hoạt động</a>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/login')} className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-300 hover:text-white transition">
              Đăng nhập
            </button>
            <button onClick={() => navigate('/register')} className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition">
              Đăng kí
            </button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative pt-32 pb-20 px-6">
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-600/20 rounded-full blur-[120px]" />
          <div className="absolute top-1/3 right-1/4 w-96 h-96 bg-indigo-600/15 rounded-full blur-[120px]" />
        </div>
        <div className="relative max-w-4xl mx-auto text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-medium mb-6"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Tự động hóa toàn bộ quy trình tạo YouTube Shorts
          </motion.div>
          <motion.h1
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
            className="text-5xl md:text-6xl font-bold text-white tracking-tight leading-[1.1]"
          >
            Tạo YouTube Shorts<br/>
            <span className="bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">bằng AI, tự động</span>
          </motion.h1>
           <motion.p
             initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
             className="text-lg text-slate-400 mt-6 max-w-2xl mx-auto leading-relaxed"
           >
             Hai chế độ: <span className="text-slate-200">Review phim</span> (phim 2–3 tiếng → video review 20–30 phút) và <span className="text-slate-200">Dịch &amp; Lồng tiếng</span> (video nước ngoài có hardsub → phụ đề tiếng Việt theo 12 phong cách + giọng lồng AI). AI tự động tạo đầu ra — không cần tự edit.
           </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
            className="flex items-center justify-center gap-4 mt-8"
          >
            <button onClick={startNow} className="flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold transition shadow-lg shadow-blue-600/30">
              Tạo video đầu tiên <ArrowRight className="w-4 h-4" />
            </button>
            <button onClick={() => navigate('/login')} className="flex items-center gap-2 px-6 py-3 rounded-xl border border-white/10 hover:border-white/20 text-slate-300 font-semibold transition">
              <Play className="w-4 h-4" /> Đăng nhập
            </button>
          </motion.div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-20 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-white">Mọi thứ bạn cần trong một nền tảng</h2>
            <p className="text-slate-400 mt-2">Kiến trúc đa nhà cung cấp, linh hoạt và mở rộng</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {features.map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }} transition={{ delay: i * 0.1 }}
                className="rounded-2xl bg-[#161922] border border-white/5 p-6 hover:border-blue-500/20 transition"
              >
                <div className="w-11 h-11 rounded-xl bg-blue-500/10 flex items-center justify-center mb-4">
                  <f.icon className="w-5 h-5 text-blue-400" />
                </div>
                <h3 className="font-semibold text-white">{f.title}</h3>
                <p className="text-sm text-slate-400 mt-1.5 leading-relaxed">{f.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="py-20 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-white">Quy trình đơn giản</h2>
            <p className="text-slate-400 mt-2">Từ tệp đầu vào đến video hoàn chỉnh</p>
          </div>
          <div className="space-y-4">
            {modes.map((s, i) => (
              <motion.div
                key={s.num}
                initial={{ opacity: 0, x: -20 }} whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }} transition={{ delay: i * 0.08 }}
                className="flex items-center gap-5 p-5 rounded-2xl bg-[#161922] border border-white/5"
              >
                <div className="text-2xl font-bold text-blue-500/40 w-12">{s.num}</div>
                <div className="text-white font-medium">{s.label}</div>
                {i < modes.length - 1 && <ArrowRight className="w-4 h-4 text-slate-600 ml-auto hidden sm:block" />}
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-6">
        <div className="max-w-2xl mx-auto text-center">
          <div className="rounded-3xl bg-gradient-to-br from-blue-600/20 to-indigo-600/10 border border-blue-500/20 p-10">
            <h2 className="text-3xl font-bold text-white">Sẵn sàng tạo video?</h2>
            <p className="text-slate-400 mt-2">Tham gia ngay — miễn phí bắt đầu</p>
            <button onClick={startNow} className="mt-6 inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold transition">
              Bắt đầu ngay <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </section>

      <footer className="py-8 border-t border-white/5 text-center text-sm text-slate-500">
        AI Shorts Factory — Tự động hóa sản xuất video bằng AI
      </footer>
    </div>
  );
}