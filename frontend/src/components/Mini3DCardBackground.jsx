import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useTheme } from 'next-themes';

const COLOR_MAP = {
  blue: {
    primary: 0x3b82f6,
    accent: 0x60a5fa,
    ambient: 0x1d4ed8,
  },
  violet: {
    primary: 0x8b5cf6,
    accent: 0xa78bfa,
    ambient: 0x6d28d9,
  },
  cyan: {
    primary: 0x06b6d4,
    accent: 0x38bdf8,
    ambient: 0x0e7490,
  },
  purple: {
    primary: 0xa855f7,
    accent: 0xc084fc,
    ambient: 0x7e22ce,
  },
  emerald: {
    primary: 0x10b981,
    accent: 0x34d399,
    ambient: 0x047857,
  },
};

export default function Mini3DCardBackground({
  shapeType = 'icosahedron',
  color = 'blue',
  speed = 1.0,
  className = '',
}) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    let isVisible = true;
    let animId = null;
    const isDark = resolvedTheme === 'dark';
    const colors = COLOR_MAP[color] || COLOR_MAP.blue;

    // 1. Scene & Camera
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.z = 4.0;

    // 2. Renderer
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const updateSize = () => {
      if (!container) return;
      const width = container.clientWidth || 320;
      const height = container.clientHeight || 320;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    updateSize();

    const resizeObserver = new ResizeObserver(() => {
      updateSize();
    });
    resizeObserver.observe(container);

    // 3. Smooth Lighting
    const ambientLight = new THREE.AmbientLight(
      isDark ? 0x1e1e38 : 0xf1f5f9,
      isDark ? 1.2 : 1.6
    );
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(colors.primary, isDark ? 2.8 : 2.2);
    dirLight1.position.set(2.5, 3.5, 3.5);
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(colors.accent, isDark ? 1.9 : 1.5);
    dirLight2.position.set(-3.0, -2.5, 2.5);
    scene.add(dirLight2);

    const pointLight = new THREE.PointLight(colors.accent, isDark ? 2.2 : 1.4, 7);
    pointLight.position.set(0, 0, 1.5);
    scene.add(pointLight);

    // 4. Mesh Group
    const group = new THREE.Group();
    scene.add(group);

    const disposableGeometries = [];
    const disposableMaterials = [];

    // Smooth Translucent Crystal Physical Material
    const innerMaterial = new THREE.MeshPhysicalMaterial({
      color: colors.primary,
      emissive: colors.ambient,
      emissiveIntensity: isDark ? 0.38 : 0.22,
      roughness: 0.16,
      metalness: 0.12,
      clearcoat: 0.8,
      clearcoatRoughness: 0.1,
      transmission: 0.55,
      transparent: true,
      opacity: isDark ? 0.65 : 0.48,
      side: THREE.DoubleSide,
    });
    disposableMaterials.push(innerMaterial);

    // Delicate Smooth Wireframe
    const wireMaterial = new THREE.MeshBasicMaterial({
      color: isDark ? colors.accent : colors.primary,
      wireframe: true,
      transparent: true,
      opacity: isDark ? 0.32 : 0.22,
      blending: THREE.AdditiveBlending,
    });
    disposableMaterials.push(wireMaterial);

    // Stardust Micro Particles
    const particleCount = 26;
    const particleGeo = new THREE.BufferGeometry();
    const particlePositions = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount * 3; i += 3) {
      particlePositions[i] = (Math.random() - 0.5) * 3.6;
      particlePositions[i + 1] = (Math.random() - 0.5) * 3.6;
      particlePositions[i + 2] = (Math.random() - 0.5) * 2.2;
    }
    particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    disposableGeometries.push(particleGeo);

    const particleMat = new THREE.PointsMaterial({
      color: colors.accent,
      size: 0.052,
      transparent: true,
      opacity: isDark ? 0.65 : 0.45,
      blending: THREE.AdditiveBlending,
    });
    disposableMaterials.push(particleMat);

    const particleSystem = new THREE.Points(particleGeo, particleMat);
    group.add(particleSystem);

    let extraRing = null;
    let extraRing2 = null;

    if (shapeType === 'icosahedron') {
      // Smooth subdivided icosahedron
      const geo = new THREE.IcosahedronGeometry(1.15, 1);
      geo.computeVertexNormals();
      disposableGeometries.push(geo);

      const mesh = new THREE.Mesh(geo, innerMaterial);
      const wire = new THREE.Mesh(geo, wireMaterial);
      wire.scale.setScalar(1.02);

      group.add(mesh);
      group.add(wire);
    } else if (shapeType === 'torusKnot') {
      // Organic Torus Knot
      const geo = new THREE.TorusKnotGeometry(0.82, 0.27, 96, 24, 2, 3);
      disposableGeometries.push(geo);

      const mesh = new THREE.Mesh(geo, innerMaterial);
      const wire = new THREE.Mesh(geo, wireMaterial);
      wire.scale.setScalar(1.018);

      group.add(mesh);
      group.add(wire);
    } else if (shapeType === 'octahedron') {
      // Subdivided Octahedron with orbital precession ring
      const geo = new THREE.OctahedronGeometry(1.1, 1);
      geo.computeVertexNormals();
      disposableGeometries.push(geo);

      const mesh = new THREE.Mesh(geo, innerMaterial);
      const wire = new THREE.Mesh(geo, wireMaterial);
      wire.scale.setScalar(1.02);

      group.add(mesh);
      group.add(wire);

      // Precessing orbital ring
      const ringGeo = new THREE.TorusGeometry(1.58, 0.024, 16, 64);
      disposableGeometries.push(ringGeo);
      const ringMat = new THREE.MeshBasicMaterial({
        color: colors.accent,
        transparent: true,
        opacity: isDark ? 0.45 : 0.3,
        blending: THREE.AdditiveBlending,
      });
      disposableMaterials.push(ringMat);

      extraRing = new THREE.Mesh(ringGeo, ringMat);
      extraRing.rotation.x = Math.PI / 3.2;
      group.add(extraRing);
    } else if (shapeType === 'dodecahedron') {
      // Smooth Dodecahedron
      const geo = new THREE.DodecahedronGeometry(1.08, 1);
      geo.computeVertexNormals();
      disposableGeometries.push(geo);

      const mesh = new THREE.Mesh(geo, innerMaterial);
      const wire = new THREE.Mesh(geo, wireMaterial);
      wire.scale.setScalar(1.02);

      group.add(mesh);
      group.add(wire);
    } else if (shapeType === 'rings') {
      // Dual concentric gyroscopic rings
      const ring1Geo = new THREE.TorusGeometry(1.15, 0.065, 20, 64);
      const ring2Geo = new THREE.TorusGeometry(0.82, 0.05, 20, 64);
      disposableGeometries.push(ring1Geo, ring2Geo);

      extraRing = new THREE.Mesh(ring1Geo, innerMaterial);
      extraRing2 = new THREE.Mesh(ring2Geo, wireMaterial);
      extraRing.rotation.x = Math.PI / 4;
      extraRing2.rotation.y = Math.PI / 3;

      group.add(extraRing);
      group.add(extraRing2);
    } else {
      // Default Smooth Sphere
      const geo = new THREE.SphereGeometry(1.08, 32, 32);
      disposableGeometries.push(geo);

      const mesh = new THREE.Mesh(geo, innerMaterial);
      const wire = new THREE.Mesh(geo, wireMaterial);
      wire.scale.setScalar(1.015);

      group.add(mesh);
      group.add(wire);
    }

    // Interactive mouse hover tilt with lerp
    let targetRotX = 0;
    let targetRotY = 0;

    const handlePointerMove = (e) => {
      const rect = container.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      targetRotX = y * 0.35;
      targetRotY = x * 0.35;
    };

    container.addEventListener('pointermove', handlePointerMove);

    const observer = new IntersectionObserver(
      ([entry]) => {
        isVisible = entry.isIntersecting;
      },
      { threshold: 0.1 }
    );
    observer.observe(container);

    // Smooth Harmonic Animation Loop
    const clock = new THREE.Clock();

    const animate = () => {
      animId = requestAnimationFrame(animate);

      if (!isVisible) return;

      const delta = clock.getDelta();
      const t = clock.getElapsedTime() * speed;

      // Graceful multi-axis harmonic zero-gravity rotation (no rigid repetition)
      group.rotation.x += (Math.sin(t * 0.45) * 0.32 + Math.cos(t * 0.28) * 0.18 + targetRotX - group.rotation.x) * 0.04;
      group.rotation.y += (t * 0.22 + Math.sin(t * 0.32) * 0.2 + targetRotY - group.rotation.y) * 0.04;
      group.rotation.z = Math.cos(t * 0.36) * 0.18;

      // Soft vertical & horizontal floating
      group.position.y = Math.sin(t * 0.65) * 0.14 + Math.cos(t * 0.42) * 0.06;
      group.position.x = Math.cos(t * 0.52) * 0.08;

      // Gentle organic breathing scale
      const breathe = 1.0 + Math.sin(t * 0.75) * 0.035;
      group.scale.setScalar(breathe);

      if (extraRing) {
        extraRing.rotation.z += delta * 0.55;
        extraRing.rotation.x += delta * 0.35;
      }
      if (extraRing2) {
        extraRing2.rotation.y += delta * 0.65;
        extraRing2.rotation.z -= delta * 0.4;
      }

      particleSystem.rotation.y -= delta * 0.12;

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      if (animId) cancelAnimationFrame(animId);
      observer.disconnect();
      resizeObserver.disconnect();
      container.removeEventListener('pointermove', handlePointerMove);

      disposableGeometries.forEach((g) => g.dispose());
      disposableMaterials.forEach((m) => m.dispose());
      renderer.dispose();
    };
  }, [shapeType, color, speed, resolvedTheme]);

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 overflow-hidden pointer-events-none select-none ${className}`}
    >
      <canvas ref={canvasRef} className="w-full h-full block" />
    </div>
  );
}
