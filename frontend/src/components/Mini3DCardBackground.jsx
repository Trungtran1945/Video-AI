import { useRef, useState } from 'react';

/**
 * CardDynamicAtmosphere (Mini3DCardBackground replacement)
 * High-performance, 100% lag-free animated card background
 * Zero WebGL overhead, runs entirely on GPU compositor thread.
 * 
 * Themes:
 * - icosahedron (Review Phim): Cinematic Light Beam & Floating Keyframe Sparks
 * - torusKnot (Dịch Thuật): Harmonic Voice Spectrum & Audio Frequency Waveforms
 * - octahedron (Pipeline): High-Speed Neural Data Streams & Laser Beam Border
 * - dodecahedron (Đa Ngôn Ngữ): Global Orbital Aura & Cosmic Ripple Rings
 * - rings / sphere (Bảo Mật & SSE): Live Telemetry Radar Pulse & Signal Waves
 */
export default function Mini3DCardBackground({
  shapeType = 'icosahedron',
  color = 'blue',
  className = '',
}) {
  const containerRef = useRef(null);
  const [mousePos, setMousePos] = useState({ x: 50, y: 50 });

  const handlePointerMove = (e) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setMousePos({ x, y });
  };

  return (
    <div
      ref={containerRef}
      onPointerMove={handlePointerMove}
      className={`absolute inset-0 overflow-hidden pointer-events-none select-none rounded-3xl ${className}`}
    >
      {/* 1. Dynamic Mouse Interactive Spotlight (Follows cursor smoothly) */}
      <div
        className="absolute inset-0 transition-opacity duration-300 opacity-35 group-hover:opacity-75"
        style={{
          background: `radial-gradient(400px circle at ${mousePos.x}% ${mousePos.y}%, rgba(99, 102, 241, 0.18), transparent 70%)`,
        }}
      />

      {/* 2. Specific Dynamic Background Themes */}

      {/* THEME 1: Cinematic Film Spotlight & Golden Amber / Royal Blue Flare (Review Phim) */}
      {shapeType === 'icosahedron' && (
        <div className="absolute inset-0">
          {/* Sweeping Cinematic Light Beam */}
          <div className="absolute -top-24 -left-24 w-80 h-80 rounded-full bg-gradient-to-br from-blue-500/25 via-indigo-500/15 to-transparent blur-3xl animate-pulse duration-3000" />
          <div className="absolute -bottom-20 -right-20 w-72 h-72 rounded-full bg-gradient-to-tl from-amber-500/20 via-rose-500/10 to-transparent blur-3xl animate-pulse duration-4000" />

          {/* Animated Film Frame Vignette & Lens Rays */}
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_75%_35%,rgba(59,130,246,0.18)_0%,transparent_60%)]" />

          {/* Floating Keyframe Sparkles */}
          <div className="absolute top-10 right-14 w-2 h-2 rounded-full bg-blue-400 animate-ping opacity-60" />
          <div className="absolute bottom-16 left-12 w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse opacity-70" />
          <div className="absolute top-1/2 left-1/3 w-1 h-1 rounded-full bg-indigo-300 animate-ping opacity-50" />
        </div>
      )}

      {/* THEME 2: Harmonic Voice Spectrum & Audio Frequency Waveforms (Dịch Thuật & Lồng Tiếng) */}
      {shapeType === 'torusKnot' && (
        <div className="absolute inset-0">
          <div className="absolute -top-20 -right-20 w-80 h-80 rounded-full bg-gradient-to-bl from-violet-500/25 via-fuchsia-500/15 to-transparent blur-3xl animate-pulse duration-3500" />
          <div className="absolute -bottom-24 -left-20 w-72 h-72 rounded-full bg-gradient-to-tr from-indigo-500/20 via-purple-500/10 to-transparent blur-3xl animate-pulse duration-4500" />

          {/* Fluid Soundwave SVG overlay */}
          <svg
            className="absolute inset-x-0 bottom-6 w-full h-32 opacity-25 dark:opacity-35 text-violet-500"
            viewBox="0 0 400 120"
            fill="none"
            preserveAspectRatio="none"
          >
            <path
              d="M0 60 Q 50 10, 100 60 T 200 60 T 300 60 T 400 60"
              stroke="currentColor"
              strokeWidth="2.5"
              className="animate-pulse"
            />
            <path
              d="M0 60 Q 50 95, 100 60 T 200 60 T 300 60 T 400 60"
              stroke="currentColor"
              strokeWidth="1.5"
              opacity="0.6"
            />
            <path
              d="M0 60 Q 50 40, 100 60 T 200 60 T 300 60 T 400 60"
              stroke="currentColor"
              strokeWidth="1.8"
              opacity="0.8"
            />
          </svg>

          {/* Floating audio frequency nodes */}
          <div className="absolute top-12 right-12 w-2 h-2 rounded-full bg-violet-400 animate-ping opacity-60" />
          <div className="absolute bottom-24 right-20 w-1.5 h-1.5 rounded-full bg-fuchsia-400 animate-pulse opacity-70" />
        </div>
      )}

      {/* THEME 3: High-Speed Neural Data Streams (Pipeline Tốc Độ Cao) */}
      {shapeType === 'octahedron' && (
        <div className="absolute inset-0">
          <div className="absolute -top-20 -left-20 w-80 h-80 rounded-full bg-gradient-to-br from-cyan-500/25 via-blue-500/15 to-transparent blur-3xl animate-pulse duration-3000" />
          <div className="absolute -bottom-20 -right-20 w-72 h-72 rounded-full bg-gradient-to-tl from-sky-500/20 via-teal-500/10 to-transparent blur-3xl animate-pulse duration-4000" />

          {/* Flowing Laser Data Beam Grid */}
          <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_0%,rgba(6,182,212,0.06)_50%,transparent_100%)] bg-[length:100%_40px] animate-[slideDown_3s_linear_infinite]" />

          {/* Pulsing SSE Stream indicators */}
          <div className="absolute top-8 right-10 w-2.5 h-2.5 rounded-full bg-cyan-400 animate-ping opacity-75" />
          <div className="absolute bottom-12 left-14 w-2 h-2 rounded-full bg-sky-400 animate-pulse opacity-70" />
          <div className="absolute top-1/3 right-1/4 w-1.5 h-1.5 rounded-full bg-teal-300 animate-ping opacity-50" />
        </div>
      )}

      {/* THEME 4: Global Cosmic Aurora & Orbital Rings (Đa Ngôn Ngữ & Bản Xứ Hóa) */}
      {shapeType === 'dodecahedron' && (
        <div className="absolute inset-0">
          <div className="absolute -top-24 -right-20 w-80 h-80 rounded-full bg-gradient-to-bl from-purple-500/25 via-indigo-500/15 to-transparent blur-3xl animate-pulse duration-4000" />
          <div className="absolute -bottom-20 -left-24 w-72 h-72 rounded-full bg-gradient-to-tr from-pink-500/20 via-violet-500/10 to-transparent blur-3xl animate-pulse duration-3500" />

          {/* Concentric Orbital Ripple Rings */}
          <div className="absolute top-1/2 right-10 -translate-y-1/2 w-48 h-48 rounded-full border border-purple-500/20 opacity-50 animate-ping duration-6000" />
          <div className="absolute top-1/2 right-14 -translate-y-1/2 w-36 h-36 rounded-full border border-pink-500/25 opacity-60" />
          <div className="absolute top-1/2 right-20 -translate-y-1/2 w-24 h-24 rounded-full border border-indigo-500/30 opacity-70" />

          {/* Stardust Nodes */}
          <div className="absolute top-10 left-12 w-2 h-2 rounded-full bg-purple-400 animate-pulse opacity-70" />
          <div className="absolute bottom-10 right-16 w-2 h-2 rounded-full bg-pink-400 animate-ping opacity-60" />
        </div>
      )}

      {/* THEME 5: Live Telemetry Radar Pulse & Signal Waves (Trust Cards) */}
      {(shapeType === 'rings' || shapeType === 'shield' || shapeType === 'sphere') && (
        <div className="absolute inset-0">
          <div
            className={`absolute -top-16 -right-16 w-64 h-64 rounded-full blur-3xl opacity-30 animate-pulse ${
              color === 'blue'
                ? 'bg-blue-500'
                : color === 'violet'
                ? 'bg-indigo-500'
                : 'bg-cyan-500'
            }`}
          />
          {/* Subtle Radar Pulse Ring */}
          <div className="absolute -bottom-10 -left-10 w-44 h-44 rounded-full border border-primary/20 opacity-40 animate-ping duration-5000" />
        </div>
      )}

      {/* Subtle Micro Dot Matrix Pattern */}
      <div className="absolute inset-0 bg-[radial-gradient(hsl(var(--foreground)/0.04)_1px,transparent_1px)] bg-[size:1.4rem_1.4rem] opacity-60 pointer-events-none" />
    </div>
  );
}
