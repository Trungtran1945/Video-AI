import { useEffect, useRef } from 'react';
import { useTheme } from 'next-themes';

export default function HeroAnimation() {
  const canvasRef = useRef(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId;
    let width = (canvas.width = canvas.offsetWidth);
    let height = (canvas.height = canvas.offsetHeight);

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Handle resize
    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = canvas.offsetWidth;
      height = canvas.height = canvas.offsetHeight;
    };
    window.addEventListener('resize', handleResize);

    const isDark = resolvedTheme === 'dark';

    // Particle nodes representing video frames / audio pulses
    const nodeCount = Math.min(32, Math.floor(width / 35));
    const nodes = [];
    for (let i = 0; i < nodeCount; i++) {
      nodes.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.45,
        vy: (Math.random() - 0.5) * 0.45,
        radius: Math.random() * 2 + 1.2,
        alpha: Math.random() * 0.45 + 0.2,
      });
    }

    // Floating subtle beam orbs
    const orbs = [
      { x: width * 0.25, y: height * 0.35, r: width * 0.28, vx: 0.15, vy: 0.1, hue: isDark ? 222 : 215 },
      { x: width * 0.75, y: height * 0.45, r: width * 0.32, vx: -0.12, vy: 0.08, hue: isDark ? 250 : 230 },
      { x: width * 0.5, y: height * 0.7, r: width * 0.25, vx: 0.08, vy: -0.12, hue: isDark ? 200 : 210 },
    ];

    if (prefersReducedMotion) {
      // Draw single static frame
      drawFrame(0);
      return () => {
        window.removeEventListener('resize', handleResize);
      };
    }

    let t = 0;
    function drawFrame() {
      t += 0.008;
      ctx.clearRect(0, 0, width, height);

      // Draw subtle ambient aurora orbs
      orbs.forEach((orb) => {
        orb.x += orb.vx;
        orb.y += orb.vy;
        if (orb.x < width * 0.1 || orb.x > width * 0.9) orb.vx *= -1;
        if (orb.y < height * 0.1 || orb.y > height * 0.9) orb.vy *= -1;

        const grad = ctx.createRadialGradient(orb.x, orb.y, 0, orb.x, orb.y, orb.r);
        if (isDark) {
          grad.addColorStop(0, `hsla(${orb.hue}, 85%, 55%, 0.14)`);
          grad.addColorStop(0.5, `hsla(${orb.hue}, 80%, 45%, 0.05)`);
          grad.addColorStop(1, 'transparent');
        } else {
          grad.addColorStop(0, `hsla(${orb.hue}, 85%, 65%, 0.18)`);
          grad.addColorStop(0.6, `hsla(${orb.hue}, 80%, 75%, 0.06)`);
          grad.addColorStop(1, 'transparent');
        }
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(orb.x, orb.y, orb.r, 0, Math.PI * 2);
        ctx.fill();
      });

      // Draw connecting lines between nodes
      const maxDist = 140;
      const lineColor = isDark ? '99, 140, 255' : '59, 130, 246';
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < maxDist) {
            const alpha = (1 - dist / maxDist) * (isDark ? 0.16 : 0.12);
            ctx.strokeStyle = `rgba(${lineColor}, ${alpha})`;
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.stroke();
          }
        }
      }

      // Draw and update particle nodes
      nodes.forEach((node) => {
        node.x += node.vx;
        node.y += node.vy;

        if (node.x < 0) node.x = width;
        if (node.x > width) node.x = 0;
        if (node.y < 0) node.y = height;
        if (node.y > height) node.y = 0;

        ctx.fillStyle = isDark
          ? `rgba(165, 195, 255, ${node.alpha * 0.9})`
          : `rgba(37, 99, 235, ${node.alpha * 0.7})`;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fill();
      });

      animationFrameId = requestAnimationFrame(drawFrame);
    }

    animationFrameId = requestAnimationFrame(drawFrame);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    };
  }, [resolvedTheme]);

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none select-none">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ opacity: 0.95 }}
      />
      {/* Subtle grid mesh overlay */}
      <div
        className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border)/0.25)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border)/0.25)_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_40%,#000_70%,transparent_100%)] opacity-60 pointer-events-none"
      />
      {/* Bottom fade into background */}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-background via-background/80 to-transparent" />
    </div>
  );
}
