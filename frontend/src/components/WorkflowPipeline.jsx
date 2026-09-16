import { useState, useRef, useEffect } from 'react';
import {
  Layers, UploadCloud, SlidersHorizontal, Cpu,
  CheckCircle2, Sparkles, ChevronRight, Activity,
  ChevronLeft
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
    iconColor: 'text-blue-500 bg-blue-500/10 border-blue-500/20',
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
    iconColor: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/20',
  },
  {
    num: '03',
    code: 'STAGE_CONFIG',
    badge: 'Tùy chỉnh phong cách',
    icon: SlidersHorizontal,
    title: 'Tùy chỉnh phong cách',
    desc: 'Chọn ngôn ngữ đích, 13 phong cách dịch văn học, giọng đọc AI và tự động nhận diện.',
    techSpec: '13 phong cách dịch & Thư viện giọng Edge/ElevenLabs',
    accent: 'violet',
    iconColor: 'text-violet-500 bg-violet-500/10 border-violet-500/20',
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
    iconColor: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/20',
  },
  {
    num: '05',
    code: 'STAGE_EXPORT',
    badge: 'Kiểm duyệt & xuất',
    icon: CheckCircle2,
    title: 'Kiểm duyệt & xuất bản',
    desc: 'Theo dõi tiến độ thời gian thực, tinh chỉnh trực quan và tải video thành phẩm sắc nét.',
    techSpec: 'Timeline trực quan & Real-time SSE Stream',
    accent: 'emerald',
    iconColor: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
  },
];

export default function WorkflowPipeline() {
  const trackRef = useRef(null);
  const singleSetRef = useRef(null);
  const animFrameIdRef = useRef(null);

  const [activeStep, setActiveStep] = useState(3);

  const offsetRef = useRef(0);
  const targetStepOffsetRef = useRef(0);
  const isHoveredRef = useRef(false);
  const singleWidthRef = useRef(0);

  // Measure single set width for seamless infinite looping
  useEffect(() => {
    const updateWidth = () => {
      if (singleSetRef.current) {
        singleWidthRef.current = singleSetRef.current.offsetWidth;
      }
    };

    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  // Continuous auto-glide from right to left
  useEffect(() => {
    let lastTime = performance.now();

    const loop = (currentTime) => {
      const delta = (currentTime - lastTime) / 1000;
      lastTime = currentTime;

      const singleWidth = singleWidthRef.current;

      // Auto-move speed ~45px per second from right to left
      if (!isHoveredRef.current && singleWidth > 0) {
        offsetRef.current += 48 * delta;
      }

      // Smooth step override if user clicked next / prev
      if (Math.abs(targetStepOffsetRef.current) > 0.5) {
        const stepAmount = targetStepOffsetRef.current * 0.15;
        offsetRef.current += stepAmount;
        targetStepOffsetRef.current -= stepAmount;
      }

      // Seamless infinite wrap-around
      if (singleWidth > 0) {
        if (offsetRef.current >= singleWidth) {
          offsetRef.current -= singleWidth;
        } else if (offsetRef.current < 0) {
          offsetRef.current += singleWidth;
        }

        const stepApproxWidth = singleWidth / pipelineSteps.length;
        const currentIdx = Math.floor((offsetRef.current % singleWidth) / stepApproxWidth) % pipelineSteps.length;
        setActiveStep(currentIdx);
      }

      if (trackRef.current) {
        trackRef.current.style.transform = `translate3d(${-offsetRef.current}px, 0, 0)`;
      }

      animFrameIdRef.current = requestAnimationFrame(loop);
    };

    animFrameIdRef.current = requestAnimationFrame(loop);
    return () => {
      if (animFrameIdRef.current) cancelAnimationFrame(animFrameIdRef.current);
    };
  }, []);

  const handleMouseEnter = () => {
    isHoveredRef.current = true;
  };

  const handleMouseLeave = () => {
    isHoveredRef.current = false;
  };

  const handleNext = () => {
    const cardWidth = singleWidthRef.current > 0 ? singleWidthRef.current / pipelineSteps.length : 360;
    targetStepOffsetRef.current += cardWidth;
  };

  const handlePrev = () => {
    const cardWidth = singleWidthRef.current > 0 ? singleWidthRef.current / pipelineSteps.length : 360;
    targetStepOffsetRef.current -= cardWidth;
  };

  const jumpToStep = (index) => {
    const cardWidth = singleWidthRef.current > 0 ? singleWidthRef.current / pipelineSteps.length : 360;
    offsetRef.current = index * cardWidth;
    targetStepOffsetRef.current = 0;
    setActiveStep(index);
  };

  return (
    <div className="relative w-full max-w-7xl mx-auto select-none">
      {/* Top Pipeline Telemetry Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-8 px-5 py-3.5 rounded-2xl bg-card/75 border border-border/80 backdrop-blur-md shadow-xs">
        <div className="flex items-center gap-2.5 text-xs font-semibold text-foreground">
          <Activity className="w-4 h-4 text-primary animate-pulse" />
          <span>Hệ Thống Pipeline AI Tự Phân Tải</span>
          <span className="hidden sm:inline text-muted-foreground font-normal">| 5 giai đoạn xử lý tuần tự tự động</span>
        </div>

        {/* Controls: Step Indicators & Navigation */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <button
              onClick={handlePrev}
              className="w-7 h-7 rounded-lg border border-border/70 bg-background/70 flex items-center justify-center text-foreground hover:bg-accent transition-colors"
              aria-label="Giai đoạn trước"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleNext}
              className="w-7 h-7 rounded-lg border border-border/70 bg-background/70 flex items-center justify-center text-foreground hover:bg-accent transition-colors"
              aria-label="Giai đoạn tiếp theo"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="hidden sm:flex items-center gap-1.5">
            {pipelineSteps.map((step, idx) => (
              <button
                key={step.num}
                onClick={() => jumpToStep(idx)}
                className={`px-2 py-0.5 rounded-lg text-xs font-mono font-bold transition-all ${
                  activeStep === idx
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {step.num}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Auto-sliding Pipeline Track with Fade Edge Mask */}
      <div
        className="w-full relative overflow-hidden"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Subtle Edge Fade Gradients */}
        <div className="absolute left-0 inset-y-0 w-8 sm:w-16 bg-gradient-to-r from-background to-transparent z-20 pointer-events-none" />
        <div className="absolute right-0 inset-y-0 w-8 sm:w-16 bg-gradient-to-l from-background to-transparent z-20 pointer-events-none" />

        <div
          ref={trackRef}
          className="flex items-stretch gap-5 w-max will-change-transform py-2"
        >
          {/* Set 1: Measured set */}
          <div ref={singleSetRef} className="flex items-stretch gap-5">
            {pipelineSteps.map((step, idx) => {
              const Icon = step.icon;
              const isCurrent = activeStep === idx;

              return (
                <div
                  key={`p1-${step.num}`}
                  onClick={() => jumpToStep(idx)}
                  className={`group relative w-[280px] sm:w-[320px] md:w-[340px] p-5 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between backdrop-blur-xl ${
                    isCurrent
                      ? 'bg-card border-primary/60 shadow-lg shadow-primary/10 ring-1 ring-primary/30'
                      : 'bg-card/85 dark:bg-card/75 border-border/80 hover:border-primary/40'
                  }`}
                >
                  <div>
                    {/* Header */}
                    <div className="flex items-center justify-between mb-3.5">
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center border transition-all ${
                          isCurrent
                            ? 'bg-primary text-primary-foreground shadow-md shadow-primary/25 scale-105'
                            : step.iconColor
                        }`}
                      >
                        <Icon className="w-5 h-5" />
                      </div>
                      <span className="font-mono text-base font-extrabold text-foreground/40">
                        {step.num}
                      </span>
                    </div>

                    {/* Step Info */}
                    <div className="space-y-1.5">
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-muted text-muted-foreground uppercase tracking-wider inline-block">
                        {step.badge}
                      </span>
                      <h4 className="text-sm sm:text-base font-bold text-foreground leading-snug">
                        {step.title}
                      </h4>
                      <p className="text-xs text-muted-foreground dark:text-slate-300 mt-1 leading-relaxed">
                        {step.desc}
                      </p>
                    </div>
                  </div>

                  {/* Step Tech Spec Footer */}
                  <div className="mt-4 pt-3 border-t border-border/60">
                    <p className="text-[11px] text-primary/90 font-mono line-clamp-1 flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3 shrink-0" />
                      <span>{step.techSpec}</span>
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Set 2: Duplicate for infinite loop */}
          <div className="flex items-stretch gap-5">
            {pipelineSteps.map((step, idx) => {
              const Icon = step.icon;
              const isCurrent = activeStep === idx;

              return (
                <div
                  key={`p2-${step.num}`}
                  onClick={() => jumpToStep(idx)}
                  className={`group relative w-[280px] sm:w-[320px] md:w-[340px] p-5 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between backdrop-blur-xl ${
                    isCurrent
                      ? 'bg-card border-primary/60 shadow-lg shadow-primary/10 ring-1 ring-primary/30'
                      : 'bg-card/85 dark:bg-card/75 border-border/80 hover:border-primary/40'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between mb-3.5">
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center border transition-all ${
                          isCurrent
                            ? 'bg-primary text-primary-foreground shadow-md shadow-primary/25 scale-105'
                            : step.iconColor
                        }`}
                      >
                        <Icon className="w-5 h-5" />
                      </div>
                      <span className="font-mono text-base font-extrabold text-foreground/40">
                        {step.num}
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-muted text-muted-foreground uppercase tracking-wider inline-block">
                        {step.badge}
                      </span>
                      <h4 className="text-sm sm:text-base font-bold text-foreground leading-snug">
                        {step.title}
                      </h4>
                      <p className="text-xs text-muted-foreground dark:text-slate-300 mt-1 leading-relaxed">
                        {step.desc}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-border/60">
                    <p className="text-[11px] text-primary/90 font-mono line-clamp-1 flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3 shrink-0" />
                      <span>{step.techSpec}</span>
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Set 3: Extra duplicate for ultra-wide screens */}
          <div className="flex items-stretch gap-5">
            {pipelineSteps.map((step, idx) => {
              const Icon = step.icon;
              const isCurrent = activeStep === idx;

              return (
                <div
                  key={`p3-${step.num}`}
                  onClick={() => jumpToStep(idx)}
                  className={`group relative w-[280px] sm:w-[320px] md:w-[340px] p-5 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between backdrop-blur-xl ${
                    isCurrent
                      ? 'bg-card border-primary/60 shadow-lg shadow-primary/10 ring-1 ring-primary/30'
                      : 'bg-card/85 dark:bg-card/75 border-border/80 hover:border-primary/40'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between mb-3.5">
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center border transition-all ${
                          isCurrent
                            ? 'bg-primary text-primary-foreground shadow-md shadow-primary/25 scale-105'
                            : step.iconColor
                        }`}
                      >
                        <Icon className="w-5 h-5" />
                      </div>
                      <span className="font-mono text-base font-extrabold text-foreground/40">
                        {step.num}
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-muted text-muted-foreground uppercase tracking-wider inline-block">
                        {step.badge}
                      </span>
                      <h4 className="text-sm sm:text-base font-bold text-foreground leading-snug">
                        {step.title}
                      </h4>
                      <p className="text-xs text-muted-foreground dark:text-slate-300 mt-1 leading-relaxed">
                        {step.desc}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-border/60">
                    <p className="text-[11px] text-primary/90 font-mono line-clamp-1 flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3 shrink-0" />
                      <span>{step.techSpec}</span>
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Pipeline Highlight Callout */}
      <div className="mt-8 p-4 sm:p-5 rounded-2xl bg-card/60 border border-border/70 backdrop-blur-md flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <span className="font-bold text-foreground">Cơ chế Hàng Đợi Bền Vững:</span>{' '}
            <span className="text-muted-foreground dark:text-slate-300">
              Tự động tái thử khi gặp giới hạn tốc độ API (Rate Limit), lưu trạng thái từng chunk video an toàn.
            </span>
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1.5 font-semibold text-primary">
          <span>Hệ thống tự động hóa</span>
          <ChevronRight className="w-3.5 h-3.5" />
        </div>
      </div>
    </div>
  );
}
