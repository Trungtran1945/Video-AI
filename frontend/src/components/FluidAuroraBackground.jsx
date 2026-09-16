import { useEffect, useRef } from 'react';
import { useTheme } from 'next-themes';

/**
 * FluidAuroraBackground - High-performance, buttery-smooth 60fps Aurora & Light Stream Background
 * Designed specifically for AI Video Platform aesthetics.
 * - Multi-layered harmonic fluid aurora ribbons with organic undulation
 * - Volumetric ambient light blooms with smooth mouse parallax
 * - Twinkling cinematic stardust micro-particles
 * - Pure 2D Canvas hardware acceleration (Zero WebGL lag, 0 frame drops)
 * - Adapts cleanly to Dark & Light themes
 */
export default function FluidAuroraBackground({ className = '' }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId = null;
    let isVisible = true;
    let width = 0;
    let height = 0;

    const isDark = resolvedTheme === 'dark';

    // Track mouse with smooth damping (lerp)
    const mouse = {
      targetX: 0,
      targetY: 0,
      currentX: 0,
      currentY: 0,
    };

    const handleMouseMove = (e) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = (e.clientY / window.innerHeight) * 2 - 1;
      mouse.targetX = nx;
      mouse.targetY = ny;
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });

    // High DPI Canvas resize handling
    const handleResize = () => {
      if (!canvas || !container) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = container.clientWidth || window.innerWidth;
      height = container.clientHeight || window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    // Dynamic Aurora Blooms Configuration
    const blooms = [
      {
        baseX: 0.25,
        baseY: 0.35,
        radiusRatio: 0.45,
        colorDark: 'rgba(59, 130, 246, 0.22)', // Royal Blue
        colorLight: 'rgba(59, 130, 246, 0.12)',
        speedX: 0.00035,
        speedY: 0.00045,
        phase: 0,
      },
      {
        baseX: 0.72,
        baseY: 0.42,
        radiusRatio: 0.48,
        colorDark: 'rgba(139, 92, 246, 0.20)', // Violet
        colorLight: 'rgba(139, 92, 246, 0.11)',
        speedX: -0.0004,
        speedY: 0.00035,
        phase: Math.PI / 3,
      },
      {
        baseX: 0.50,
        baseY: 0.65,
        radiusRatio: 0.40,
        colorDark: 'rgba(6, 182, 212, 0.16)', // Electric Cyan
        colorLight: 'rgba(6, 182, 212, 0.09)',
        speedX: 0.0003,
        speedY: -0.0004,
        phase: Math.PI / 1.5,
      },
      {
        baseX: 0.42,
        baseY: 0.28,
        radiusRatio: 0.35,
        colorDark: 'rgba(249, 115, 22, 0.14)', // Warm Amber/Coral core
        colorLight: 'rgba(249, 115, 22, 0.08)',
        speedX: -0.0003,
        speedY: -0.0003,
        phase: Math.PI * 1.2,
      },
      {
        baseX: 0.65,
        baseY: 0.75,
        radiusRatio: 0.36,
        colorDark: 'rgba(236, 72, 153, 0.14)', // Magenta accent
        colorLight: 'rgba(236, 72, 153, 0.07)',
        speedX: 0.00025,
        speedY: 0.0003,
        phase: Math.PI * 1.7,
      },
    ];

    // Flowing Harmonic Aurora Wave Ribbons
    const waves = [
      {
        yRatio: 0.38,
        amplitude: 65,
        frequency: 0.0016,
        speed: 0.0009,
        colorStart: isDark ? 'rgba(59, 130, 246, 0.28)' : 'rgba(37, 99, 235, 0.16)',
        colorMid: isDark ? 'rgba(139, 92, 246, 0.24)' : 'rgba(124, 58, 237, 0.14)',
        colorEnd: isDark ? 'rgba(6, 182, 212, 0.0)' : 'rgba(6, 182, 212, 0.0)',
        lineWidth: 2.2,
      },
      {
        yRatio: 0.52,
        amplitude: 80,
        frequency: 0.0012,
        speed: -0.0007,
        colorStart: isDark ? 'rgba(168, 85, 247, 0.26)' : 'rgba(147, 51, 234, 0.15)',
        colorMid: isDark ? 'rgba(236, 72, 153, 0.20)' : 'rgba(219, 39, 119, 0.12)',
        colorEnd: isDark ? 'rgba(249, 115, 22, 0.0)' : 'rgba(249, 115, 22, 0.0)',
        lineWidth: 2.6,
      },
      {
        yRatio: 0.66,
        amplitude: 55,
        frequency: 0.0018,
        speed: 0.0011,
        colorStart: isDark ? 'rgba(6, 182, 212, 0.22)' : 'rgba(14, 165, 233, 0.14)',
        colorMid: isDark ? 'rgba(59, 130, 246, 0.18)' : 'rgba(37, 99, 235, 0.10)',
        colorEnd: isDark ? 'rgba(99, 102, 241, 0.0)' : 'rgba(99, 102, 241, 0.0)',
        lineWidth: 1.8,
      },
    ];

    // Stardust Micro Particles
    const particleCount = 45;
    const particles = [];
    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: Math.random() * (width || 1200),
        y: Math.random() * (height || 800),
        vx: (Math.random() - 0.5) * 0.18,
        vy: -Math.random() * 0.25 - 0.08,
        radius: Math.random() * 1.4 + 0.6,
        alpha: Math.random() * 0.55 + 0.2,
        pulseSpeed: Math.random() * 0.015 + 0.008,
        pulsePhase: Math.random() * Math.PI * 2,
      });
    }

    // Visibility Observer to pause when off-screen
    const observer = new IntersectionObserver(
      ([entry]) => {
        isVisible = entry.isIntersecting;
      },
      { threshold: 0.05 }
    );
    observer.observe(container);

    // Animation Loop
    let time = 0;

    const render = (timestamp) => {
      animId = requestAnimationFrame(render);

      if (!isVisible) return;

      time = timestamp || 0;

      // Mouse damping interpolation
      mouse.currentX += (mouse.targetX - mouse.currentX) * 0.035;
      mouse.currentY += (mouse.targetY - mouse.currentY) * 0.035;

      ctx.clearRect(0, 0, width, height);

      // 1. Volumetric Luminous Aurora Blooms
      blooms.forEach((bloom) => {
        const oscX = Math.sin(time * bloom.speedX + bloom.phase) * (width * 0.08);
        const oscY = Math.cos(time * bloom.speedY + bloom.phase) * (height * 0.09);
        const bx = bloom.baseX * width + oscX + mouse.currentX * 18;
        const by = bloom.baseY * height + oscY + mouse.currentY * 14;
        const radius = bloom.radiusRatio * width;

        const radGrad = ctx.createRadialGradient(bx, by, 0, bx, by, radius);
        const color = isDark ? bloom.colorDark : bloom.colorLight;

        radGrad.addColorStop(0, color);
        radGrad.addColorStop(0.5, color.replace(/[\d.]+\)$/, '0.05)'));
        radGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

        ctx.fillStyle = radGrad;
        ctx.beginPath();
        ctx.arc(bx, by, radius, 0, Math.PI * 2);
        ctx.fill();
      });

      // 2. Flowing Harmonic Aurora Wave Ribbons
      waves.forEach((wave) => {
        const baseY = wave.yRatio * height + mouse.currentY * 12;
        const steps = 48;
        const stepWidth = width / steps;

        // Draw glowing wave fill
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(0, height);

        for (let i = 0; i <= steps; i++) {
          const x = i * stepWidth;
          const y =
            baseY +
            Math.sin(x * wave.frequency + time * wave.speed) * wave.amplitude +
            Math.cos(x * wave.frequency * 0.6 + time * wave.speed * 0.8) * (wave.amplitude * 0.35);

          if (i === 0) {
            ctx.lineTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }

        ctx.lineTo(width, height);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, baseY - wave.amplitude, 0, height);
        grad.addColorStop(0, wave.colorStart);
        grad.addColorStop(0.35, wave.colorMid);
        grad.addColorStop(1, wave.colorEnd);

        ctx.fillStyle = grad;
        ctx.fill();

        // Wave crest line with soft glow
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const x = i * stepWidth;
          const y =
            baseY +
            Math.sin(x * wave.frequency + time * wave.speed) * wave.amplitude +
            Math.cos(x * wave.frequency * 0.6 + time * wave.speed * 0.8) * (wave.amplitude * 0.35);

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.strokeStyle = wave.colorStart;
        ctx.lineWidth = wave.lineWidth;
        ctx.stroke();

        ctx.restore();
      });

      // 3. Stardust Micro Particles
      ctx.save();
      particles.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0) p.x = width;
        if (p.x > width) p.x = 0;
        if (p.y < 0) p.y = height;
        if (p.y > height) p.y = 0;

        const pulse = Math.sin(time * p.pulseSpeed + p.pulsePhase);
        const alpha = Math.max(0.08, p.alpha + pulse * 0.2);

        ctx.fillStyle = isDark
          ? `rgba(186, 230, 253, ${alpha})`
          : `rgba(37, 99, 235, ${alpha * 0.8})`;

        ctx.beginPath();
        ctx.arc(p.x + mouse.currentX * 10, p.y + mouse.currentY * 8, p.radius, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
    };

    animId = requestAnimationFrame(render);

    return () => {
      if (animId) cancelAnimationFrame(animId);
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, [resolvedTheme]);

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 overflow-hidden pointer-events-none select-none ${className}`}
    >
      <canvas ref={canvasRef} className="w-full h-full block" />

      {/* Modern Perspective Grid Matrix with Radial Vignette */}
      <div
        className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--primary)/0.05)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--primary)/0.05)_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_65%_55%_at_50%_40%,#000_65%,transparent_100%)] opacity-60 pointer-events-none"
      />

      {/* Subtle Coordinate Dots */}
      <div
        className="absolute inset-0 bg-[radial-gradient(hsl(var(--primary)/0.18)_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_55%_45%_at_50%_35%,#000_50%,transparent_100%)] opacity-50 pointer-events-none"
      />

      {/* Top Ambient Flare */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 max-w-4xl h-52 bg-gradient-to-b from-primary/15 via-primary/5 to-transparent blur-3xl pointer-events-none" />

      {/* Bottom seamless blend into content */}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-background via-background/80 to-transparent pointer-events-none" />
    </div>
  );
}
