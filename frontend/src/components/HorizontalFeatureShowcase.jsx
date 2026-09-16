import { useRef, useState, useEffect } from 'react';
import {
  Clapperboard,
  Languages,
  Zap,
  Globe,
  CheckCircle2,
  Sparkles,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import Mini3DCardBackground from '@/components/Mini3DCardBackground';

const features = [
  {
    num: '01',
    shape: 'icosahedron',
    color: 'blue',
    badge: 'Pipeline Thông Minh',
    icon: Clapperboard,
    title: 'Review Phim Tự Động',
    subtitle: 'Rút gọn phim 2–3 tiếng thành video tóm tắt 20–30 phút sẵn sàng đăng tải',
    desc: 'Hệ thống tự động phát hiện cảnh cao trào, nhận diện diễn biến kịch bản quan trọng, phân tích cảm xúc nhân vật và xuất video tóm tắt cuốn hút với tiết tấu điện ảnh.',
    highlights: [
      'Nhận diện phân cảnh tự động (Scene Detect)',
      'Tự động viết kịch bản tóm tắt mạch lạc',
      'Xuất video Full HD chuẩn tỷ lệ 16:9 & 9:16',
    ],
    tagColor: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/25',
    accentBorder: 'hover:border-blue-500/50',
    glowColor: 'from-blue-500/15 via-blue-500/5 to-transparent',
  },
  {
    num: '02',
    shape: 'torusKnot',
    color: 'violet',
    badge: '13 Phong Cách Dịch',
    icon: Languages,
    title: 'Dịch Thuật & Lồng Tiếng',
    subtitle: 'Biên dịch video ngoại ngữ tự nhiên, lồng giọng AI đồng bộ chuẩn xác',
    desc: 'Tải video nước ngoài bất kỳ, AI phân tích âm thanh, dịch chuẩn theo 13 sắc thái văn phong từ hóm hỉnh, kịch tính đến học thuật, sau đó lồng giọng AI đồng bộ từng khuôn hình.',
    highlights: [
      '13 phong cách dịch văn học & đời thường',
      'Đồng bộ nhịp điệu & khẩu hình thời gian thực',
      'Kho giọng đọc Edge & ElevenLabs đa sắc thái',
    ],
    tagColor: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/25',
    accentBorder: 'hover:border-violet-500/50',
    glowColor: 'from-violet-500/15 via-violet-500/5 to-transparent',
  },
  {
    num: '03',
    shape: 'octahedron',
    color: 'cyan',
    badge: 'Real-time SSE',
    icon: Zap,
    title: 'Pipeline Nền Tốc Độ Cao',
    subtitle: 'Hàng đợi thông minh tự phân tải, tự động retry khi chạm rate limit',
    desc: 'Cấu trúc hàng đợi bất đồng bộ phân tán xử lý video siêu nhanh. Theo dõi trực tiếp tiến trình từng giây qua kết nối Server-Sent Events mà không lo nghẽn trình duyệt.',
    highlights: [
      'Phân tải thông minh không nghẽn tài nguyên',
      'Tự động chia nhỏ video 5MB & Auto Resume',
      'Khôi phục checkpoint an toàn khi rớt mạng',
    ],
    tagColor: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/25',
    accentBorder: 'hover:border-cyan-500/50',
    glowColor: 'from-cyan-500/15 via-cyan-500/5 to-transparent',
  },
  {
    num: '04',
    shape: 'dodecahedron',
    color: 'purple',
    badge: 'Đa Giọng Đọc',
    icon: Globe,
    title: 'Đa Ngôn Ngữ & Bản Xứ Hóa',
    subtitle: 'Hỗ trợ hơn 8 ngôn ngữ nguồn với giọng đọc chuẩn từng vùng miền',
    desc: 'Hỗ trợ video tiếng Anh, Trung, Nhật, Hàn, Pháp... Thư viện giọng đọc AI tự nhiên mang trọn vẹn ngữ điệu, chuẩn âm sắc vùng miền Bắc, Trung, Nam của tiếng Việt.',
    highlights: [
      'Nhận dạng giọng nói chuẩn xác qua Whisper STT',
      'Tùy chỉnh cao độ, tốc độ & cảm xúc giọng đọc',
      'Bản quyền thương mại hóa hoàn toàn tự do',
    ],
    tagColor: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/25',
    accentBorder: 'hover:border-purple-500/50',
    glowColor: 'from-purple-500/15 via-purple-500/5 to-transparent',
  },
];

export default function HorizontalFeatureShowcase({ onStart }) {
  const trackRef = useRef(null);
  const singleSetRef = useRef(null);
  const animFrameIdRef = useRef(null);

  const [activeCardIndex, setActiveCardIndex] = useState(0);

  const offsetRef = useRef(0);
  const targetStepOffsetRef = useRef(0);
  const isHoveredRef = useRef(false);
  const singleWidthRef = useRef(0);

  // Measure single set width for seamless infinite loop wrapping
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

  // Continuous auto-sliding loop from right to left
  useEffect(() => {
    let lastTime = performance.now();

    const loop = (currentTime) => {
      const delta = (currentTime - lastTime) / 1000;
      lastTime = currentTime;

      const singleWidth = singleWidthRef.current;

      // Base auto-movement speed: ~50 pixels per second from right to left
      if (!isHoveredRef.current && singleWidth > 0) {
        offsetRef.current += 55 * delta;
      }

      // Smooth step override if user clicked next / prev
      if (Math.abs(targetStepOffsetRef.current) > 0.5) {
        const stepAmount = targetStepOffsetRef.current * 0.15;
        offsetRef.current += stepAmount;
        targetStepOffsetRef.current -= stepAmount;
      }

      // Seamless infinite wrapping
      if (singleWidth > 0) {
        if (offsetRef.current >= singleWidth) {
          offsetRef.current -= singleWidth;
        } else if (offsetRef.current < 0) {
          offsetRef.current += singleWidth;
        }

        // Active index indicator
        const cardApproxWidth = singleWidth / features.length;
        const currentIdx = Math.floor((offsetRef.current % singleWidth) / cardApproxWidth) % features.length;
        setActiveCardIndex(currentIdx);
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
    // Step forward by 1 card width (~480px)
    const cardWidth = singleWidthRef.current > 0 ? singleWidthRef.current / features.length : 480;
    targetStepOffsetRef.current += cardWidth;
  };

  const handlePrev = () => {
    // Step backward by 1 card width
    const cardWidth = singleWidthRef.current > 0 ? singleWidthRef.current / features.length : 480;
    targetStepOffsetRef.current -= cardWidth;
  };

  // Jump to specific feature index
  const jumpToIndex = (index) => {
    const cardWidth = singleWidthRef.current > 0 ? singleWidthRef.current / features.length : 480;
    offsetRef.current = index * cardWidth;
    targetStepOffsetRef.current = 0;
    setActiveCardIndex(index);
  };

  return (
    <section
      id="features"
      className="relative py-20 sm:py-24 border-t border-border/60 bg-background/50 overflow-hidden select-none"
    >
      {/* Subtle Ambient Section Glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-6xl h-80 bg-gradient-to-r from-blue-500/10 via-indigo-500/10 to-cyan-500/10 blur-3xl pointer-events-none -z-10" />

      {/* Section Header */}
      <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 mb-8 sm:mb-10">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-5">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-xs font-semibold text-primary mb-2.5">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Công Nghệ Đột Phá Đa Nền Tảng</span>
            </div>
            <h2 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-foreground tracking-tight">
              Mọi công cụ bạn cần trong một nền tảng
            </h2>
            <p className="text-xs sm:text-sm text-muted-foreground dark:text-slate-300 mt-1.5 max-w-xl leading-relaxed">
              Kiến trúc đa tầng mạnh mẽ kết hợp AI sinh hình ảnh, âm thanh và xử lý video tự động hóa hoàn toàn.
            </p>
          </div>

          {/* Controls: Prev/Next, and Index Badges */}
          <div className="flex items-center gap-3 shrink-0">

            {/* Prev / Next buttons */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={handlePrev}
                className="w-9 h-9 rounded-xl border border-border/80 bg-card/80 flex items-center justify-center text-foreground hover:bg-accent transition-all shadow-xs"
                aria-label="Khung trước"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={handleNext}
                className="w-9 h-9 rounded-xl border border-border/80 bg-card/80 flex items-center justify-center text-foreground hover:bg-accent transition-all shadow-xs"
                aria-label="Khung tiếp theo"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {/* Step Badges */}
            <div className="flex items-center gap-1.5 p-1 rounded-xl bg-card/80 border border-border/70 backdrop-blur-md">
              {features.map((f, i) => (
                <button
                  key={f.num}
                  onClick={() => jumpToIndex(i)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold transition-all ${
                    activeCardIndex === i
                      ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/30 scale-105'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  }`}
                >
                  {f.num}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Auto-sliding Horizontal Track with Fade Edge Mask */}
      <div
        className="w-full relative overflow-hidden"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Subtle Edge Fade Gradients for cinematic entrance/exit */}
        <div className="absolute left-0 inset-y-0 w-8 sm:w-16 bg-gradient-to-r from-background to-transparent z-20 pointer-events-none" />
        <div className="absolute right-0 inset-y-0 w-8 sm:w-16 bg-gradient-to-l from-background to-transparent z-20 pointer-events-none" />

        <div
          ref={trackRef}
          className="flex items-stretch gap-6 sm:gap-8 w-max will-change-transform py-2"
        >
          {/* Set 1: Measured for wrap-around width */}
          <div ref={singleSetRef} className="flex items-stretch gap-6 sm:gap-8">
            {features.map((feature) => {
              const Icon = feature.icon;

              return (
                <div
                  key={`set1-${feature.num}`}
                  className={`group relative w-[320px] sm:w-[420px] md:w-[460px] lg:w-[480px] rounded-3xl border border-border/80 bg-card/85 dark:bg-card/75 shadow-xl hover:shadow-2xl transition-all duration-300 flex flex-col justify-between overflow-hidden backdrop-blur-xl ${feature.accentBorder}`}
                >
                  <Mini3DCardBackground shapeType={feature.shape} color={feature.color} />

                  <div
                    className={`absolute inset-0 bg-gradient-to-br ${feature.glowColor} pointer-events-none opacity-50 group-hover:opacity-100 transition-opacity`}
                  />

                  <div className="relative z-10 p-6 sm:p-8 flex flex-col justify-between h-full">
                    <div>
                      <div className="flex items-center justify-between mb-4">
                        <div className="w-12 h-12 rounded-2xl bg-card border border-border/80 flex items-center justify-center shadow-md shadow-black/5 group-hover:scale-110 transition-transform">
                          <Icon className="w-6 h-6 text-primary" />
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${feature.tagColor} backdrop-blur-sm`}
                          >
                            {feature.badge}
                          </span>
                          <span className="font-mono text-base font-extrabold text-muted-foreground/60">
                            {feature.num}
                          </span>
                        </div>
                      </div>

                      <h3 className="text-xl sm:text-2xl font-bold text-foreground group-hover:text-primary transition-colors leading-tight">
                        {feature.title}
                      </h3>
                      <p className="text-xs sm:text-sm font-medium text-primary/90 mt-1">
                        {feature.subtitle}
                      </p>
                      <p className="text-xs sm:text-sm text-muted-foreground dark:text-slate-300 mt-3 leading-relaxed">
                        {feature.desc}
                      </p>
                    </div>

                    <div className="mt-6 pt-5 border-t border-border/60 space-y-2.5">
                      {feature.highlights.map((point) => (
                        <div key={point} className="flex items-center gap-2.5 text-xs text-foreground/90 font-medium">
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                          <span>{point}</span>
                        </div>
                      ))}
                    </div>

                    <div className="mt-6 pt-4 flex items-center justify-between">
                      <span className="text-[11px] font-mono text-muted-foreground dark:text-slate-400">
                        AI Engine Active
                      </span>
                      <button
                        onClick={onStart}
                        className="inline-flex items-center gap-1.5 text-xs font-bold text-primary group-hover:underline"
                      >
                        <span>Trải nghiệm</span>
                        <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-1" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Set 2: Duplicate for seamless infinite loop */}
          <div className="flex items-stretch gap-6 sm:gap-8">
            {features.map((feature) => {
              const Icon = feature.icon;

              return (
                <div
                  key={`set2-${feature.num}`}
                  className={`group relative w-[320px] sm:w-[420px] md:w-[460px] lg:w-[480px] rounded-3xl border border-border/80 bg-card/85 dark:bg-card/75 shadow-xl hover:shadow-2xl transition-all duration-300 flex flex-col justify-between overflow-hidden backdrop-blur-xl ${feature.accentBorder}`}
                >
                  <Mini3DCardBackground shapeType={feature.shape} color={feature.color} />

                  <div
                    className={`absolute inset-0 bg-gradient-to-br ${feature.glowColor} pointer-events-none opacity-50 group-hover:opacity-100 transition-opacity`}
                  />

                  <div className="relative z-10 p-6 sm:p-8 flex flex-col justify-between h-full">
                    <div>
                      <div className="flex items-center justify-between mb-4">
                        <div className="w-12 h-12 rounded-2xl bg-card border border-border/80 flex items-center justify-center shadow-md shadow-black/5 group-hover:scale-110 transition-transform">
                          <Icon className="w-6 h-6 text-primary" />
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${feature.tagColor} backdrop-blur-sm`}
                          >
                            {feature.badge}
                          </span>
                          <span className="font-mono text-base font-extrabold text-muted-foreground/60">
                            {feature.num}
                          </span>
                        </div>
                      </div>

                      <h3 className="text-xl sm:text-2xl font-bold text-foreground group-hover:text-primary transition-colors leading-tight">
                        {feature.title}
                      </h3>
                      <p className="text-xs sm:text-sm font-medium text-primary/90 mt-1">
                        {feature.subtitle}
                      </p>
                      <p className="text-xs sm:text-sm text-muted-foreground dark:text-slate-300 mt-3 leading-relaxed">
                        {feature.desc}
                      </p>
                    </div>

                    <div className="mt-6 pt-5 border-t border-border/60 space-y-2.5">
                      {feature.highlights.map((point) => (
                        <div key={point} className="flex items-center gap-2.5 text-xs text-foreground/90 font-medium">
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                          <span>{point}</span>
                        </div>
                      ))}
                    </div>

                    <div className="mt-6 pt-4 flex items-center justify-between">
                      <span className="text-[11px] font-mono text-muted-foreground dark:text-slate-400">
                        AI Engine Active
                      </span>
                      <button
                        onClick={onStart}
                        className="inline-flex items-center gap-1.5 text-xs font-bold text-primary group-hover:underline"
                      >
                        <span>Trải nghiệm</span>
                        <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-1" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Set 3: Extra duplicate for ultra-wide screen continuity */}
          <div className="flex items-stretch gap-6 sm:gap-8">
            {features.map((feature) => {
              const Icon = feature.icon;

              return (
                <div
                  key={`set3-${feature.num}`}
                  className={`group relative w-[320px] sm:w-[420px] md:w-[460px] lg:w-[480px] rounded-3xl border border-border/80 bg-card/85 dark:bg-card/75 shadow-xl hover:shadow-2xl transition-all duration-300 flex flex-col justify-between overflow-hidden backdrop-blur-xl ${feature.accentBorder}`}
                >
                  <Mini3DCardBackground shapeType={feature.shape} color={feature.color} />

                  <div
                    className={`absolute inset-0 bg-gradient-to-br ${feature.glowColor} pointer-events-none opacity-50 group-hover:opacity-100 transition-opacity`}
                  />

                  <div className="relative z-10 p-6 sm:p-8 flex flex-col justify-between h-full">
                    <div>
                      <div className="flex items-center justify-between mb-4">
                        <div className="w-12 h-12 rounded-2xl bg-card border border-border/80 flex items-center justify-center shadow-md shadow-black/5 group-hover:scale-110 transition-transform">
                          <Icon className="w-6 h-6 text-primary" />
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${feature.tagColor} backdrop-blur-sm`}
                          >
                            {feature.badge}
                          </span>
                          <span className="font-mono text-base font-extrabold text-muted-foreground/60">
                            {feature.num}
                          </span>
                        </div>
                      </div>

                      <h3 className="text-xl sm:text-2xl font-bold text-foreground group-hover:text-primary transition-colors leading-tight">
                        {feature.title}
                      </h3>
                      <p className="text-xs sm:text-sm font-medium text-primary/90 mt-1">
                        {feature.subtitle}
                      </p>
                      <p className="text-xs sm:text-sm text-muted-foreground dark:text-slate-300 mt-3 leading-relaxed">
                        {feature.desc}
                      </p>
                    </div>

                    <div className="mt-6 pt-5 border-t border-border/60 space-y-2.5">
                      {feature.highlights.map((point) => (
                        <div key={point} className="flex items-center gap-2.5 text-xs text-foreground/90 font-medium">
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                          <span>{point}</span>
                        </div>
                      ))}
                    </div>

                    <div className="mt-6 pt-4 flex items-center justify-between">
                      <span className="text-[11px] font-mono text-muted-foreground dark:text-slate-400">
                        AI Engine Active
                      </span>
                      <button
                        onClick={onStart}
                        className="inline-flex items-center gap-1.5 text-xs font-bold text-primary group-hover:underline"
                      >
                        <span>Trải nghiệm</span>
                        <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-1" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

        </div>
      </div>
    </section>
  );
}
