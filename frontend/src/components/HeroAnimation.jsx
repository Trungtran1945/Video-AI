import { useEffect, useRef } from 'react';
import { useTheme } from 'next-themes';

/**
 * HeroAnimation - Multi-layered "AI Video Production Engine" atmospheric background
 *
 * Layer 1: Base atmosphere (slow-moving volumetric color fields)
 * Layer 2: Animated luminous fields (breathing deep blue, indigo, violet, cyan)
 * Layer 3: Flowing energy streams (Bézier curves with traveling data packets: Ingest -> Process -> Render)
 * Layer 4: Subtle technical grid with coordinate crosshairs and radial mask
 * Layer 5: Sparse shimmering data nodes and video frame markers
 * Layer 6: Organic mouse parallax with damping interpolation (disabled on mobile & reduced-motion)
 */
export default function HeroAnimation() {
  const canvasRef = useRef(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId;
    let width = 0;
    let height = 0;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isTouchDevice = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768;
    const isDark = resolvedTheme === 'dark';

    // Track mouse with smooth damping (lerp)
    const mouse = {
      targetX: 0,
      targetY: 0,
      currentX: 0,
      currentY: 0,
    };

    const handleMouseMove = (e) => {
      if (isTouchDevice || prefersReducedMotion) return;
      // Normalized between -1 and 1
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = (e.clientY / window.innerHeight) * 2 - 1;
      mouse.targetX = nx;
      mouse.targetY = ny;
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });

    // Handle high DPI canvas sizing
    const handleResize = () => {
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.offsetWidth;
      height = canvas.offsetHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    // ==========================================
    // Layer 2: Volumetric Luminous Orbs
    // ==========================================
    const orbs = [
      {
        baseX: 0.2,
        baseY: 0.28,
        radiusRatio: 0.32,
        colorDark: 'rgba(37, 99, 235, 0.16)', // Royal Blue
        colorLight: 'rgba(59, 130, 246, 0.12)',
        speedX: 0.0004,
        speedY: 0.0006,
        phase: 0,
      },
      {
        baseX: 0.8,
        baseY: 0.38,
        radiusRatio: 0.36,
        colorDark: 'rgba(99, 102, 241, 0.14)', // Indigo
        colorLight: 'rgba(99, 102, 241, 0.10)',
        speedX: -0.0005,
        speedY: 0.0004,
        phase: Math.PI / 3,
      },
      {
        baseX: 0.5,
        baseY: 0.65,
        radiusRatio: 0.28,
        colorDark: 'rgba(14, 165, 233, 0.12)', // Cyan
        colorLight: 'rgba(14, 165, 233, 0.08)',
        speedX: 0.0003,
        speedY: -0.0005,
        phase: Math.PI / 1.5,
      },
      {
        baseX: 0.35,
        baseY: 0.82,
        radiusRatio: 0.24,
        colorDark: 'rgba(168, 85, 247, 0.10)', // Violet
        colorLight: 'rgba(168, 85, 247, 0.06)',
        speedX: -0.0004,
        speedY: -0.0003,
        phase: Math.PI,
      },
    ];

    // ==========================================
    // Layer 3: Flowing Processing Streams (Energy Beams)
    // Symbolizing: Data Ingest -> AI Synthesis -> Video Rendering
    // ==========================================
    const streams = [
      {
        yRatio: 0.35,
        amplitude: 45,
        frequency: 0.0018,
        speed: 0.0012,
        packetSpeed: 0.0016,
        packetProgress: 0.15,
        color: isDark ? 'rgba(56, 189, 248, 0.35)' : 'rgba(37, 99, 235, 0.25)',
        pulseColor: isDark ? 'rgba(125, 211, 252, 0.95)' : 'rgba(37, 99, 235, 0.85)',
      },
      {
        yRatio: 0.55,
        amplitude: 60,
        frequency: 0.0014,
        speed: -0.0009,
        packetSpeed: 0.0012,
        packetProgress: 0.65,
        color: isDark ? 'rgba(129, 140, 248, 0.30)' : 'rgba(99, 102, 241, 0.22)',
        pulseColor: isDark ? 'rgba(199, 210, 254, 0.95)' : 'rgba(99, 102, 241, 0.85)',
      },
      {
        yRatio: 0.72,
        amplitude: 40,
        frequency: 0.0022,
        speed: 0.0015,
        packetSpeed: 0.002,
        packetProgress: 0.4,
        color: isDark ? 'rgba(192, 132, 252, 0.28)' : 'rgba(168, 85, 247, 0.20)',
        pulseColor: isDark ? 'rgba(233, 213, 255, 0.95)' : 'rgba(168, 85, 247, 0.85)',
      },
    ];

    // ==========================================
    // Layer 5: Data Nodes / Frame Markers
    // Sparse, cinematic particles representing video timestamps & AI tokens
    // ==========================================
    const nodeCount = isTouchDevice ? 14 : Math.min(28, Math.max(16, Math.floor(width / 50)));
    const nodes = [];
    for (let i = 0; i < nodeCount; i++) {
      nodes.push({
        x: Math.random() * (width || 1200),
        y: Math.random() * (height || 800),
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        radius: Math.random() * 1.5 + 1.0,
        alpha: Math.random() * 0.5 + 0.2,
        pulseSpeed: Math.random() * 0.02 + 0.01,
        pulsePhase: Math.random() * Math.PI * 2,
        isKeyframe: i % 7 === 0, // Rare keyframe indicator
      });
    }

    // Static frame render if reduced motion
    if (prefersReducedMotion) {
      drawStaticFrame();
      return () => {
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('mousemove', handleMouseMove);
      };
    }

    let time = 0;

    function render(timestamp) {
      time = timestamp || 0;

      // Mouse damping interpolation (smoother feel)
      mouse.currentX += (mouse.targetX - mouse.currentX) * 0.045;
      mouse.currentY += (mouse.targetY - mouse.currentY) * 0.045;

      ctx.clearRect(0, 0, width, height);

      // ========================================
      // LAYER 1: Deep Atmosphere Mesh
      // ========================================
      const bgGrad = ctx.createRadialGradient(
        width * 0.5 + mouse.currentX * 8,
        height * 0.4 + mouse.currentY * 6,
        0,
        width * 0.5,
        height * 0.45,
        width * 0.7
      );

      if (isDark) {
        bgGrad.addColorStop(0, 'rgba(17, 24, 39, 0.6)');
        bgGrad.addColorStop(0.5, 'rgba(15, 23, 42, 0.3)');
        bgGrad.addColorStop(1, 'rgba(10, 15, 28, 0)');
      } else {
        bgGrad.addColorStop(0, 'rgba(239, 246, 255, 0.7)');
        bgGrad.addColorStop(0.6, 'rgba(241, 245, 249, 0.3)');
        bgGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      }
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      // ========================================
      // LAYER 2: Volumetric Luminous Orbs
      // Soft ambient light breathing with parallax
      // ========================================
      ctx.save();
      orbs.forEach((orb) => {
        const oscX = Math.sin(time * orb.speedX + orb.phase) * (width * 0.05);
        const oscY = Math.cos(time * orb.speedY + orb.phase) * (height * 0.06);
        const orbX = orb.baseX * width + oscX + mouse.currentX * 12;
        const orbY = orb.baseY * height + oscY + mouse.currentY * 10;
        const radius = orb.radiusRatio * width;

        const radGrad = ctx.createRadialGradient(orbX, orbY, 0, orbX, orbY, radius);
        const color = isDark ? orb.colorDark : orb.colorLight;

        radGrad.addColorStop(0, color);
        radGrad.addColorStop(0.6, color.replace(/[\d.]+\)$/, '0.04)'));
        radGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

        ctx.fillStyle = radGrad;
        ctx.beginPath();
        ctx.arc(orbX, orbY, radius, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();

      // ========================================
      // LAYER 3: Flowing Energy Streams
      // Bézier curves simulating video processing pipelines
      // ========================================
      ctx.save();
      streams.forEach((stream) => {
        const baseY = stream.yRatio * height + mouse.currentY * 8;
        const packetT = (time * stream.packetSpeed + stream.packetProgress) % 1;

        ctx.beginPath();
        const steps = 30;
        let packetPos = { x: 0, y: baseY };

        for (let i = 0; i <= steps; i++) {
          const ratio = i / steps;
          const x = ratio * width;
          const y =
            baseY +
            Math.sin(x * stream.frequency + time * stream.speed) * stream.amplitude +
            Math.cos(x * stream.frequency * 0.5 + time * stream.speed * 0.8) * 15;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }

          // Compute position of the traveling packet
          if (Math.abs(ratio - packetT) < 1 / steps) {
            packetPos = { x, y };
          }
        }

        ctx.strokeStyle = stream.color;
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // Draw traveling glowing data pulse
        if (packetPos.x > 0 && packetPos.x < width) {
          const pulseGlow = ctx.createRadialGradient(
            packetPos.x,
            packetPos.y,
            0,
            packetPos.x,
            packetPos.y,
            16
          );
          pulseGlow.addColorStop(0, stream.pulseColor);
          pulseGlow.addColorStop(0.4, stream.pulseColor.replace(/[\d.]+\)$/, '0.35)'));
          pulseGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');

          ctx.fillStyle = pulseGlow;
          ctx.beginPath();
          ctx.arc(packetPos.x, packetPos.y, 16, 0, Math.PI * 2);
          ctx.fill();

          // Pulse core
          ctx.fillStyle = isDark ? '#ffffff' : '#2563eb';
          ctx.beginPath();
          ctx.arc(packetPos.x, packetPos.y, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      });
      ctx.restore();

      // ========================================
      // LAYER 5: Floating Data Nodes & Keyframe Indicators
      // With delicate proximity connections
      // ========================================
      ctx.save();
      const maxDist = 130;
      const lineColor = isDark ? '99, 140, 255' : '59, 130, 246';

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < maxDist) {
            const alpha = (1 - dist / maxDist) * (isDark ? 0.14 : 0.08);
            ctx.strokeStyle = `rgba(${lineColor}, ${alpha})`;
            ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.moveTo(nodes[i].x + mouse.currentX * 16, nodes[i].y + mouse.currentY * 12);
            ctx.lineTo(nodes[j].x + mouse.currentX * 16, nodes[j].y + mouse.currentY * 12);
            ctx.stroke();
          }
        }
      }

      // Render node markers
      nodes.forEach((node) => {
        node.x += node.vx;
        node.y += node.vy;

        if (node.x < 0) node.x = width;
        if (node.x > width) node.x = 0;
        if (node.y < 0) node.y = height;
        if (node.y > height) node.y = 0;

        const pulse = Math.sin(time * node.pulseSpeed + node.pulsePhase);
        const currentAlpha = Math.max(0.1, node.alpha + pulse * 0.18);
        const renderX = node.x + mouse.currentX * 18;
        const renderY = node.y + mouse.currentY * 14;

        if (node.isKeyframe) {
          // Special diamond keyframe icon
          ctx.fillStyle = isDark
            ? `rgba(147, 197, 253, ${currentAlpha * 0.9})`
            : `rgba(37, 99, 235, ${currentAlpha * 0.8})`;
          ctx.beginPath();
          const s = node.radius * 1.8;
          ctx.moveTo(renderX, renderY - s);
          ctx.lineTo(renderX + s, renderY);
          ctx.lineTo(renderX, renderY + s);
          ctx.lineTo(renderX - s, renderY);
          ctx.closePath();
          ctx.fill();
        } else {
          // Circular particle node
          ctx.fillStyle = isDark
            ? `rgba(165, 195, 255, ${currentAlpha * 0.8})`
            : `rgba(37, 99, 235, ${currentAlpha * 0.6})`;
          ctx.beginPath();
          ctx.arc(renderX, renderY, node.radius, 0, Math.PI * 2);
          ctx.fill();
        }
      });
      ctx.restore();

      animationFrameId = requestAnimationFrame(render);
    }

    function drawStaticFrame() {
      ctx.clearRect(0, 0, width, height);

      // Simple ambient backdrop for reduced-motion
      const bgGrad = ctx.createRadialGradient(
        width * 0.5,
        height * 0.4,
        0,
        width * 0.5,
        height * 0.45,
        width * 0.6
      );
      if (isDark) {
        bgGrad.addColorStop(0, 'rgba(30, 58, 138, 0.25)');
        bgGrad.addColorStop(1, 'rgba(10, 15, 28, 0)');
      } else {
        bgGrad.addColorStop(0, 'rgba(219, 234, 254, 0.4)');
        bgGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      }
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);
    }

    animationFrameId = requestAnimationFrame(render);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handleMouseMove);
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    };
  }, [resolvedTheme]);

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none select-none">
      {/* Canvas rendering Layers 1, 2, 3, 5, 6 */}
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ opacity: 0.96 }}
      />

      {/* Layer 4: Subtle Perspective & Technical Coordinates Grid with Radial Vignette */}
      <div
        className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--primary)/0.07)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--primary)/0.07)_1px,transparent_1px)] bg-[size:4.5rem_4.5rem] [mask-image:radial-gradient(ellipse_65%_55%_at_50%_40%,#000_65%,transparent_100%)] opacity-70 pointer-events-none"
      />

      {/* Subtle coordinate crosshair dots on grid intersections */}
      <div
        className="absolute inset-0 bg-[radial-gradient(hsl(var(--primary)/0.2)_1px,transparent_1px)] bg-[size:4.5rem_4.5rem] [mask-image:radial-gradient(ellipse_55%_45%_at_50%_35%,#000_50%,transparent_100%)] opacity-60 pointer-events-none"
      />

      {/* Ambient Top Light Flare */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 max-w-4xl h-56 bg-gradient-to-b from-primary/10 via-primary/5 to-transparent blur-3xl pointer-events-none"
      />

      {/* Bottom seamless blend into content */}
      <div className="absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-background via-background/85 to-transparent" />
    </div>
  );
}
