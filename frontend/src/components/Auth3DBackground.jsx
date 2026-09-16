import { useEffect, useRef } from 'react';
import { useTheme } from 'next-themes';

/**
 * Auth3DBackground - Lag-free, high-performance fluid aurora & luminous glow background
 * for Login and Register pages.
 * Zero WebGL overhead, 60fps locked, beautifully responsive.
 */
export default function Auth3DBackground({ shapeType = 'crystalTorus', className = '' }) {
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
    const isLogin = shapeType === 'crystalTorus';

    // Track mouse
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

    // Glowing Orbs tailored for Login (Deep Indigo & Royal Blue) vs Register (Cyan & Royal Violet)
    const orbs = isLogin
      ? [
          {
            baseX: 0.35,
            baseY: 0.40,
            radiusRatio: 0.42,
            colorDark: 'rgba(59, 130, 246, 0.26)', // Royal Blue
            colorLight: 'rgba(59, 130, 246, 0.14)',
            speedX: 0.0004,
            speedY: 0.0005,
            phase: 0,
          },
          {
            baseX: 0.65,
            baseY: 0.55,
            radiusRatio: 0.45,
            colorDark: 'rgba(99, 102, 241, 0.22)', // Indigo
            colorLight: 'rgba(99, 102, 241, 0.12)',
            speedX: -0.00035,
            speedY: 0.0004,
            phase: Math.PI / 2,
          },
          {
            baseX: 0.50,
            baseY: 0.68,
            radiusRatio: 0.38,
            colorDark: 'rgba(168, 85, 247, 0.18)', // Violet
            colorLight: 'rgba(168, 85, 247, 0.10)',
            speedX: 0.0003,
            speedY: -0.00045,
            phase: Math.PI,
          },
          {
            baseX: 0.48,
            baseY: 0.32,
            radiusRatio: 0.32,
            colorDark: 'rgba(249, 115, 22, 0.12)', // Warm amber accent
            colorLight: 'rgba(249, 115, 22, 0.06)',
            speedX: -0.0003,
            speedY: -0.0003,
            phase: Math.PI * 1.5,
          },
        ]
      : [
          {
            baseX: 0.32,
            baseY: 0.45,
            radiusRatio: 0.44,
            colorDark: 'rgba(6, 182, 212, 0.24)', // Electric Cyan
            colorLight: 'rgba(6, 182, 212, 0.13)',
            speedX: 0.0004,
            speedY: 0.00045,
            phase: 0,
          },
          {
            baseX: 0.68,
            baseY: 0.40,
            radiusRatio: 0.46,
            colorDark: 'rgba(168, 85, 247, 0.22)', // Purple
            colorLight: 'rgba(168, 85, 247, 0.12)',
            speedX: -0.0004,
            speedY: 0.00035,
            phase: Math.PI / 2,
          },
          {
            baseX: 0.50,
            baseY: 0.62,
            radiusRatio: 0.40,
            colorDark: 'rgba(59, 130, 246, 0.18)', // Blue
            colorLight: 'rgba(59, 130, 246, 0.10)',
            speedX: 0.0003,
            speedY: -0.0004,
            phase: Math.PI,
          },
          {
            baseX: 0.55,
            baseY: 0.30,
            radiusRatio: 0.30,
            colorDark: 'rgba(236, 72, 153, 0.14)', // Magenta accent
            colorLight: 'rgba(236, 72, 153, 0.07)',
            speedX: -0.00025,
            speedY: 0.00035,
            phase: Math.PI * 1.4,
          },
        ];

    // Floating Stardust Nodes
    const particleCount = 35;
    const particles = [];
    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: Math.random() * (width || 1200),
        y: Math.random() * (height || 800),
        vx: (Math.random() - 0.5) * 0.2,
        vy: -Math.random() * 0.22 - 0.06,
        radius: Math.random() * 1.3 + 0.6,
        alpha: Math.random() * 0.5 + 0.2,
        pulseSpeed: Math.random() * 0.015 + 0.01,
        pulsePhase: Math.random() * Math.PI * 2,
      });
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        isVisible = entry.isIntersecting;
      },
      { threshold: 0.05 }
    );
    observer.observe(container);

    let time = 0;

    const render = (timestamp) => {
      animId = requestAnimationFrame(render);

      if (!isVisible) return;

      time = timestamp || 0;

      // Mouse damping
      mouse.currentX += (mouse.targetX - mouse.currentX) * 0.035;
      mouse.currentY += (mouse.targetY - mouse.currentY) * 0.035;

      ctx.clearRect(0, 0, width, height);

      // Render Luminous Orbs
      orbs.forEach((orb) => {
        const oscX = Math.sin(time * orb.speedX + orb.phase) * (width * 0.07);
        const oscY = Math.cos(time * orb.speedY + orb.phase) * (height * 0.08);
        const ox = orb.baseX * width + oscX + mouse.currentX * 16;
        const oy = orb.baseY * height + oscY + mouse.currentY * 12;
        const radius = orb.radiusRatio * width;

        const radGrad = ctx.createRadialGradient(ox, oy, 0, ox, oy, radius);
        const color = isDark ? orb.colorDark : orb.colorLight;

        radGrad.addColorStop(0, color);
        radGrad.addColorStop(0.55, color.replace(/[\d.]+\)$/, '0.04)'));
        radGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

        ctx.fillStyle = radGrad;
        ctx.beginPath();
        ctx.arc(ox, oy, radius, 0, Math.PI * 2);
        ctx.fill();
      });

      // Render subtle undulating wave contour
      ctx.save();
      ctx.beginPath();
      const waveY = height * 0.5 + mouse.currentY * 10;
      const steps = 36;
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * width;
        const y =
          waveY +
          Math.sin(x * 0.002 + time * 0.0008) * 45 +
          Math.cos(x * 0.0012 - time * 0.0006) * 25;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = isDark ? 'rgba(99, 102, 241, 0.18)' : 'rgba(59, 130, 246, 0.12)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();

      // Render particles
      ctx.save();
      particles.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0) p.x = width;
        if (p.x > width) p.x = 0;
        if (p.y < 0) p.y = height;
        if (p.y > height) p.y = 0;

        const pulse = Math.sin(time * p.pulseSpeed + p.pulsePhase);
        const alpha = Math.max(0.08, p.alpha + pulse * 0.18);

        ctx.fillStyle = isDark
          ? `rgba(199, 210, 254, ${alpha})`
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
  }, [shapeType, resolvedTheme]);

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 overflow-hidden pointer-events-none select-none ${className}`}
    >
      <canvas ref={canvasRef} className="w-full h-full block" />

      {/* Atmospheric Vignette & Subtle Perspective Matrix */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_50%,transparent_35%,hsl(var(--background)/0.8)_100%)] pointer-events-none" />
      <div className="absolute inset-0 bg-[radial-gradient(hsl(var(--primary)/0.1)_1px,transparent_1px)] bg-[size:3.5rem_3.5rem] opacity-35 pointer-events-none" />
    </div>
  );
}
