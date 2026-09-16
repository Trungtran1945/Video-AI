import ThreeHeroBackground from '@/components/ThreeHeroBackground';

/**
 * HeroAnimation - Wraps the Three.js organic 3D blossom background
 * Inspired by Video_AI_docs/background.mp4
 */
export default function HeroAnimation() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none select-none">
      {/* 3D WebGL Organic Blossom & Silk Ribbons Background */}
      <ThreeHeroBackground />

      {/* Layer: Subtle Perspective & Technical Coordinates Grid with Radial Vignette */}
      <div
        className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--primary)/0.06)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--primary)/0.06)_1px,transparent_1px)] bg-[size:4.5rem_4.5rem] [mask-image:radial-gradient(ellipse_65%_55%_at_50%_40%,#000_60%,transparent_100%)] opacity-60 pointer-events-none"
      />

      {/* Subtle coordinate crosshair dots on grid intersections */}
      <div
        className="absolute inset-0 bg-[radial-gradient(hsl(var(--primary)/0.18)_1px,transparent_1px)] bg-[size:4.5rem_4.5rem] [mask-image:radial-gradient(ellipse_55%_45%_at_50%_35%,#000_50%,transparent_100%)] opacity-50 pointer-events-none"
      />

      {/* Ambient Top Light Flare */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 max-w-4xl h-56 bg-gradient-to-b from-primary/15 via-primary/5 to-transparent blur-3xl pointer-events-none"
      />

      {/* Bottom seamless blend into content */}
      <div className="absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-background via-background/85 to-transparent pointer-events-none" />
    </div>
  );
}
