import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useTheme } from 'next-themes';

/**
 * ThreeHeroBackground - Ultra-fluid organic 3D blossom & silk ribbon background
 * Inspired by Video_AI_docs/background.mp4
 * Features:
 * - Silky, undulating organic petals with smooth harmonic wave deformations
 * - Translucent iridescent color gradient (Warm glowing coral core -> Rich violet/magenta -> Royal blue -> Electric cyan/lavender)
 * - Delicate silk thread striations mimicking flower petals & flowing silk fabric
 * - Zero-gravity floating, gentle breathing scale, and soft mouse parallax
 * - Beautiful in both Dark and Light modes
 */
export default function ThreeHeroBackground({ className = '' }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    let animId = null;
    let isVisible = true;
    const isDark = resolvedTheme === 'dark';

    // 1. Scene, Camera, Renderer
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 0, 7.5);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));

    const updateSize = () => {
      if (!container) return;
      const width = container.clientWidth || window.innerWidth;
      const height = container.clientHeight || window.innerHeight;
      camera.aspect = width / height;
      camera.position.z = width < 768 ? 9.6 : 7.5;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    updateSize();

    window.addEventListener('resize', updateSize);

    // 2. Mouse tracking with smooth damping
    const mouse = {
      targetX: 0,
      targetY: 0,
      currentX: 0,
      currentY: 0,
    };

    const handleMouseMove = (e) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = -(e.clientY / window.innerHeight) * 2 + 1;
      mouse.targetX = nx * 0.45;
      mouse.targetY = ny * 0.45;
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });

    let scrollY = 0;
    const handleScroll = () => {
      scrollY = window.scrollY || 0;
    };
    window.addEventListener('scroll', handleScroll, { passive: true });

    // 3. Fluid Organic Vertex & Fragment Shaders
    const vertexShader = `
      uniform float uTime;
      uniform vec2 uMouse;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying vec3 vViewPosition;

      void main() {
        vUv = uv;
        
        vec3 pos = position;

        // Silky, gentle harmonic wave undulations (slow, oceanic rhythm)
        float wave1 = sin(pos.y * 1.1 + uTime * 0.55 + pos.x * 0.7) * 0.32;
        float wave2 = cos(pos.x * 1.3 + uTime * 0.42 + pos.z * 0.8) * 0.22;
        float wave3 = sin((pos.x + pos.y) * 1.2 - uTime * 0.35) * 0.16;
        float waveRipple = sin(length(pos.xy) * 2.2 - uTime * 0.6) * 0.12;

        pos += normal * (wave1 + wave2 + wave3 + waveRipple);

        vNormal = normalize(normalMatrix * normal);
        vPosition = pos;

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        vViewPosition = -mvPosition.xyz;

        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const fragmentShader = `
      uniform float uTime;
      uniform float uTheme; // 0 = light, 1 = dark
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying vec3 vViewPosition;

      void main() {
        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(vViewPosition);

        // Fresnel edge glow for ethereal translucent silk finish
        float fresnel = pow(1.0 - abs(dot(normal, viewDir)), 2.4);

        float t = clamp(vUv.y, 0.0, 1.0);

        // Color palette inspired by background.mp4:
        // Core: warm glowing ember / coral
        vec3 colCore = vec3(1.0, 0.44, 0.18);
        // Inner petal: vivid magenta / royal violet
        vec3 colMid = vec3(0.68, 0.16, 0.94);
        // Mid body: luminous royal blue / indigo
        vec3 colBody = vec3(0.16, 0.36, 0.98);
        // Outer tips: electric cyan / soft lavender
        vec3 colRim = vec3(0.38, 0.84, 1.0);

        vec3 baseColor;
        if (t < 0.22) {
          baseColor = mix(colCore, colMid, smoothstep(0.0, 0.22, t));
        } else if (t < 0.62) {
          baseColor = mix(colMid, colBody, smoothstep(0.22, 0.62, t));
        } else {
          baseColor = mix(colBody, colRim, smoothstep(0.62, 1.0, t));
        }

        // Delicate silk thread striations (vein lines)
        float striation = sin(vUv.x * 150.0);
        float threadLine = smoothstep(0.3, 0.95, striation) * (uTheme > 0.5 ? 0.32 : 0.22);

        // Dynamic light gleam across moving surface
        float gleam = pow(max(0.0, dot(reflect(-viewDir, normal), vec3(0.3, 0.8, 0.5))), 12.0) * 0.4;

        vec3 finalColor = baseColor + threadLine + fresnel * 0.42 + gleam;

        if (uTheme < 0.5) {
          // Softer pastel blend in light mode for silk flower aesthetic
          finalColor = mix(finalColor, vec3(0.92, 0.9, 1.0), 0.16);
        }

        // Translucent alpha falloff
        float alpha = mix(0.72, 0.42, t) + fresnel * 0.38;
        if (uTheme < 0.5) {
          alpha *= 0.82;
        }

        gl_FragColor = vec4(finalColor, clamp(alpha, 0.0, 0.95));
      }
    `;

    const disposableGeometries = [];
    const disposableMaterials = [];

    const masterGroup = new THREE.Group();
    scene.add(masterGroup);

    const shaderUniforms = {
      uTime: { value: 0 },
      uTheme: { value: isDark ? 1.0 : 0.0 },
      uMouse: { value: new THREE.Vector2(0, 0) },
    };

    const petalMaterial = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: shaderUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    disposableMaterials.push(petalMaterial);

    // Create 6 sweeping organic petals with high subdivisions for silky curvature
    const numPetals = 6;
    const petalGroup = new THREE.Group();
    masterGroup.add(petalGroup);

    for (let i = 0; i < numPetals; i++) {
      const angle = (i / numPetals) * Math.PI * 2;
      // High subdivision plane: 64x64 segments
      const petalGeo = new THREE.PlaneGeometry(2.6, 4.2, 64, 64);
      disposableGeometries.push(petalGeo);

      const posAttr = petalGeo.attributes.position;
      for (let j = 0; j < posAttr.count; j++) {
        const u = (posAttr.getX(j) / 2.6) + 0.5; // 0 to 1
        const v = (posAttr.getY(j) / 4.2) + 0.5; // 0 to 1

        // Smooth width flare
        const widthFactor = Math.sin(v * Math.PI * 0.88) * 1.2 + 0.18;
        posAttr.setX(j, (u - 0.5) * 2.6 * widthFactor);

        // Graceful cupped curvature
        const cup = -Math.pow((u - 0.5) * 2.0, 2) * 0.38 * (1.0 - v * 0.25);

        // Smooth curved arch along petal length
        const arch = Math.sin(v * Math.PI * 0.72) * 1.05 - v * 0.45;

        // Subtle helical twist along petal
        const twist = Math.sin(v * Math.PI * 0.9) * 0.28 * (u - 0.5);

        posAttr.setZ(j, cup + arch + twist);
      }
      petalGeo.computeVertexNormals();

      const petalMesh = new THREE.Mesh(petalGeo, petalMaterial);

      petalMesh.rotation.z = angle;
      petalMesh.rotation.x = 0.72 + Math.sin(i * 1.4) * 0.12;
      petalMesh.rotation.y = Math.cos(i * 1.3) * 0.18;
      petalMesh.position.z = Math.sin(i * 1.1) * 0.15;

      petalGroup.add(petalMesh);
    }

    // Inner glowing core: Torus Knot with matching shader
    const coreGeo = new THREE.TorusKnotGeometry(0.95, 0.26, 120, 32, 2, 3);
    disposableGeometries.push(coreGeo);
    const coreMesh = new THREE.Mesh(coreGeo, petalMaterial);
    masterGroup.add(coreMesh);

    // Delicate wireframe veil overlay
    const wireGeo = new THREE.TorusKnotGeometry(1.02, 0.27, 80, 20, 2, 3);
    disposableGeometries.push(wireGeo);
    const wireMat = new THREE.MeshBasicMaterial({
      color: isDark ? 0x8b5cf6 : 0x6366f1,
      wireframe: true,
      transparent: true,
      opacity: isDark ? 0.22 : 0.12,
      blending: THREE.AdditiveBlending,
    });
    disposableMaterials.push(wireMat);
    const wireMesh = new THREE.Mesh(wireGeo, wireMat);
    masterGroup.add(wireMesh);

    // Stardust Particles with soft twinkle
    const particleCount = 190;
    const particleGeo = new THREE.BufferGeometry();
    const particlePositions = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i++) {
      const rad = 2.2 + Math.random() * 4.8;
      const theta = Math.random() * Math.PI * 2;
      const phi = (Math.random() - 0.5) * Math.PI * 0.85;

      particlePositions[i * 3] = Math.cos(theta) * Math.cos(phi) * rad;
      particlePositions[i * 3 + 1] = Math.sin(phi) * rad;
      particlePositions[i * 3 + 2] = Math.sin(theta) * Math.cos(phi) * rad;
    }

    particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    disposableGeometries.push(particleGeo);

    const particleMat = new THREE.PointsMaterial({
      color: isDark ? 0x93c5fd : 0x60a5fa,
      size: 0.048,
      transparent: true,
      opacity: isDark ? 0.65 : 0.45,
      blending: THREE.AdditiveBlending,
    });
    disposableMaterials.push(particleMat);

    const particleSystem = new THREE.Points(particleGeo, particleMat);
    scene.add(particleSystem);

    const observer = new IntersectionObserver(
      ([entry]) => {
        isVisible = entry.isIntersecting;
      },
      { threshold: 0.05 }
    );
    observer.observe(container);

    // 4. Silky, Harmonic Animation Loop
    const clock = new THREE.Clock();

    const animate = () => {
      animId = requestAnimationFrame(animate);

      if (!isVisible) return;

      const delta = clock.getDelta();
      const elapsedTime = clock.getElapsedTime();

      // Smooth mouse damping
      mouse.currentX += (mouse.targetX - mouse.currentX) * 0.035;
      mouse.currentY += (mouse.targetY - mouse.currentY) * 0.035;

      shaderUniforms.uTime.value = elapsedTime;
      shaderUniforms.uMouse.value.set(mouse.currentX, mouse.currentY);

      // Smooth multi-axis harmonic zero-gravity floating
      const scrollRot = scrollY * 0.0006;
      masterGroup.rotation.x = 0.22 + Math.sin(elapsedTime * 0.32) * 0.1 + mouse.currentY * 0.25;
      masterGroup.rotation.y = elapsedTime * 0.08 + Math.cos(elapsedTime * 0.24) * 0.12 + mouse.currentX * 0.3 + scrollRot;
      masterGroup.rotation.z = Math.sin(elapsedTime * 0.2) * 0.06;

      masterGroup.position.y = Math.sin(elapsedTime * 0.48) * 0.16;
      masterGroup.position.x = Math.cos(elapsedTime * 0.36) * 0.08;

      // Gentle organic breathing scale
      const breathe = 1.0 + Math.sin(elapsedTime * 0.65) * 0.03;
      masterGroup.scale.setScalar(breathe);

      // Inner core smooth counter-rotation
      coreMesh.rotation.x = elapsedTime * 0.18;
      coreMesh.rotation.y = elapsedTime * 0.24;
      wireMesh.rotation.copy(coreMesh.rotation);

      // Particles slow drift
      particleSystem.rotation.y = -elapsedTime * 0.025;
      particleSystem.rotation.x = Math.sin(elapsedTime * 0.015) * 0.08;

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      if (animId) cancelAnimationFrame(animId);
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('scroll', handleScroll);

      disposableGeometries.forEach((g) => g.dispose());
      disposableMaterials.forEach((m) => m.dispose());
      renderer.dispose();
    };
  }, [resolvedTheme]);

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 overflow-hidden pointer-events-none select-none -z-0 ${className}`}
    >
      <canvas ref={canvasRef} className="w-full h-full block" />

      {/* Atmospheric radial gradient overlay for subtle vignette */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_60%_at_50%_45%,transparent_35%,hsl(var(--background)/0.8)_100%)] pointer-events-none" />

      {/* Bottom fade into content */}
      <div className="absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-background via-background/70 to-transparent pointer-events-none" />
    </div>
  );
}
