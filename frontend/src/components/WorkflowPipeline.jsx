import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Layers, UploadCloud, SlidersHorizontal, Cpu,
  CheckCircle2, Sparkles, ChevronRight, Activity
} from 'lucide-react';

const pipelineSteps = [
  {
    num: '01',
    code: 'STAGE_MODE',
    badge: 'Chế độ sản xuất',
    icon: Layers,
    title: 'Chọn chế độ sản xuất',
    desc: 'Chọn chế độ Review phim dài hoặc Dịch thuật & Lồng tiếng video ngoại ngữ.',
    techSpec: 'Hỗ trợ Review 2-3h & Dịch thuật đa ngôn ngữ',
    accent: 'blue',
  },
  {
    num: '02',
    code: 'STAGE_INGEST',
    badge: 'Tải nguồn vào',
    icon: UploadCloud,
    title: 'Tải lên video nguồn',
    desc: 'Hỗ trợ tải video dung lượng tới 2GB với cơ chế chunking tự khôi phục khi ngắt kết nối.',
    techSpec: 'Tự động băm nhỏ chunk 5MB & Resume thông minh',
    accent: 'indigo',
  },
  {
    num: '03',
    code: 'STAGE_CONFIG',
    badge: 'Tùy chỉnh phong cách',
    icon: SlidersHorizontal,
    title: 'Tùy chỉnh phong cách',
    desc: 'Chọn ngôn ngữ đích, 13 phong cách dịch văn học, giọng đọc AI và bật/tắt nhận dạng OCR.',
    techSpec: '13 phong cách dịch & Thư viện giọng Edge/ElevenLabs',
    accent: 'violet',
  },
  {
    num: '04',
    code: 'STAGE_PROCESS',
    badge: 'AI xử lý tự động',
    icon: Cpu,
    title: 'AI xử lý tự động',
    desc: 'Hệ thống tự động chạy chuỗi: tách lời thoại, dịch kịch bản, sinh audio và biên tập khung hình.',
    techSpec: 'Whisper STT + Gemini + Neural TTS + FFmpeg',
    accent: 'cyan',
  },
  {
    num: '05',
    code: 'STAGE_EXPORT',
    badge: 'Kiểm duyệt & xuất',
    icon: CheckCircle2,
    title: 'Kiểm duyệt & xuất bản',
    desc: 'Theo dõi tiến độ thời gian thực, chỉnh sửa timeline trực quan và tải video thành phẩm sắc nét.',
    techSpec: 'Timeline chỉnh sửa trực quan & Real-time SSE',
    accent: 'emerald',
  },
];

export default function WorkflowPipeline() {
  const [activeStep, setActiveStep] = useState(3); // Highlight AI processing step by default

  return (
    <div className="relative w-full max-w-5xl mx-auto">
      {/* Top Pipeline Telemetry Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-8 px-4 py-3 rounded-2xl bg-card/60 border border-border/70 backdrop-blur-md">
        <div className="flex items-center gap-2.5 text-xs font-semibold text-foreground">
          <Activity className="w-4 h-4 text-primary animate-pulse" />
          <span>Hệ Thống Pipeline AI Tự Phân Tải</span>
          <span className="hidden sm:inline text-muted-foreground font-normal">| Luồng xử lý tuần tự tự động hóa</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
          <span className="px-2 py-0.5 rounded-md bg-muted/60 border border-border/60">5 Giai Đoạn</span>
          <span className="px-2 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20">SSE Active</span>
        </div>
      </div>

      {/* Desktop Pipeline (Horizontal Connected Flow) */}
      <div className="hidden lg:grid grid-cols-5 gap-3.5 relative">
        {/* Animated Connecting Beam Line behind nodes */}
        <div className="absolute top-[38px] left-[5%] right-[5%] h-0.5 bg-border/80 -z-0">
          <motion.div
            className="h-full bg-gradient-to-r from-blue-500 via-indigo-500 to-cyan-400"
            animate={{
              opacity: [0.4, 0.9, 0.4],
              backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'],
            }}
            transition={{
              duration: 4,
              repeat: Infinity,
              ease: 'easeInOut',
            }}
          />
        </div>

        {pipelineSteps.map((step, idx) => {
          const Icon = step.icon;
          const isActive = activeStep === idx;

          return (
            <motion.div
              key={step.num}
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: idx * 0.08, duration: 0.4 }}
              onClick={() => setActiveStep(idx)}
              className={`relative z-10 flex flex-col p-4 rounded-2xl border transition-all cursor-pointer select-none ${
                isActive
                  ? 'bg-card border-primary/50 shadow-lg shadow-primary/10 ring-1 ring-primary/30'
                  : 'bg-card/75 border-border/80 hover:border-primary/30 hover:bg-card/90'
              }`}
            >
              {/* Step Node Header */}
              <div className="flex items-center justify-between mb-3">
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all ${
                    isActive
                      ? 'bg-primary text-primary-foreground shadow-md shadow-primary/25 scale-105'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </div>
                <span className="font-mono text-sm font-extrabold text-foreground/40">
                  {step.num}
                </span>
              </div>

              {/* Step Info */}
              <div className="space-y-1.5 flex-1">
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-muted text-muted-foreground uppercase tracking-wider inline-block">
                  {step.badge}
                </span>
                <h4 className="text-xs sm:text-sm font-bold text-foreground leading-tight">
                  {step.title}
                </h4>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {step.desc}
                </p>
              </div>

              {/* Step Tech Spec Footer */}
              <div className="mt-3 pt-2.5 border-t border-border/60">
                <p className="text-[10px] text-primary/90 font-mono line-clamp-1">
                  {step.techSpec}
                </p>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Mobile & Tablet Pipeline (Connected Vertical Flow) */}
      <div className="lg:hidden space-y-3.5 relative">
        {/* Vertical Line */}
        <div className="absolute top-6 bottom-6 left-6 w-0.5 bg-border/80 -z-0" />

        {pipelineSteps.map((step, idx) => {
          const Icon = step.icon;
          const isActive = activeStep === idx;

          return (
            <motion.div
              key={step.num}
              initial={{ opacity: 0, x: -16 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: idx * 0.07, duration: 0.35 }}
              onClick={() => setActiveStep(idx)}
              className={`relative z-10 flex items-start gap-4 p-4 sm:p-5 rounded-2xl border transition-all cursor-pointer ${
                isActive
                  ? 'bg-card border-primary/50 shadow-md shadow-primary/10 ring-1 ring-primary/25'
                  : 'bg-card/75 border-border/80 hover:border-primary/30'
              }`}
            >
              {/* Step Icon Node */}
              <div
                className={`w-10 h-10 rounded-xl shrink-0 flex items-center justify-center transition-all ${
                  isActive
                    ? 'bg-primary text-primary-foreground shadow-md shadow-primary/25'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                <Icon className="w-5 h-5" />
              </div>

              {/* Step Content */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-muted text-muted-foreground uppercase tracking-wider">
                    {step.badge}
                  </span>
                  <span className="font-mono text-xs font-bold text-foreground/40">
                    {step.num}
                  </span>
                </div>
                <h4 className="text-sm font-bold text-foreground mt-1">{step.title}</h4>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{step.desc}</p>
                <div className="mt-2 text-[11px] text-primary font-mono flex items-center gap-1">
                  <Sparkles className="w-3 h-3 shrink-0" />
                  <span>{step.techSpec}</span>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Pipeline Highlight Callout */}
      <div className="mt-8 p-4 sm:p-5 rounded-2xl bg-muted/40 border border-border/70 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <span className="font-bold text-foreground">Cơ chế Hàng Đợi Bền Vững:</span>{' '}
            <span className="text-muted-foreground">
              Tự động tái thử khi gặp giới hạn tốc độ API (Rate Limit), lưu trạng thái từng chunk video an toàn.
            </span>
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1.5 font-semibold text-primary">
          <span>Xem chi tiết luồng xử lý</span>
          <ChevronRight className="w-3.5 h-3.5" />
        </div>
      </div>
    </div>
  );
}
