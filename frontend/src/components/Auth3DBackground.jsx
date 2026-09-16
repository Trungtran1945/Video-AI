import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useTheme } from 'next-themes';

/**
 * Auth3DBackground - Fluid zero-gravity 3D background for Login & Register
 * Login: Crystalline Torus Knot sculpture with luminous glass refraction
 * Register: Multi-ring Orbital Gyroscope with smooth precessing rings
 */
export default function Auth3DBackground({ shapeType = 'crystalTorus', className = '' }) {
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
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0, 6.2);

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
      camera.position.z = width < 768 ? 7.8 : 6.2;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    updateSize();

    window.addEventListener('resize', updateSize);

    // Mouse parallax with smooth damping
    const mouse = {
      targetX: 0,
      targetY: 0,
      currentX: 0,
      currentY: 0,
    };

    const handleMouseMove = (e) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = -(e.clientY / window.innerHeight) * 2 + 1;
      mouse.targetX = nx * 0.4;
      mouse.targetY = ny * 0.4;
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });

    // 2. Lights
    const ambientLight = new THREE.AmbientLight(
      isDark ? 0x1e1b4b : 0xe0e7ff,
      isDark ? 1.6 : 2.2
    );
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(
      shapeType === 'crystalTorus' ? 0x3b82f6 : 0x06b6d4,
      isDark ? 3.2 : 2.4
    );
    dirLight1.position.set(3.5, 4.5, 4.5);
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(
      shapeType === 'crystalTorus' ? 0x8b5cf6 : 0xa855f7,
      isDark ? 2.6 : 1.9
    );
    dirLight2.position.set(-4.2, -3.5, 3.2);
    scene.add(dirLight2);

    const pointLight = new THREE.PointLight(
      shapeType === 'crystalTorus' ? 0x60a5fa : 0x38bdf8,
      isDark ? 2.6 : 1.6,
      14
    );
    pointLight.position.set(0, 0, 2);
    scene.add(pointLight);

    // 3. Meshes Group
    const masterGroup = new THREE.Group();
    scene.add(masterGroup);

    const disposableGeometries = [];
    const disposableMaterials = [];

    // Luminous Crystal Physical Material
    const bodyMat = new THREE.MeshPhysicalMaterial({
      color: shapeType === 'crystalTorus' ? (isDark ? 0x4f46e5 : 0x3b82f6) : (isDark ? 0x0284c7 : 0x0ea5e9),
      emissive: shapeType === 'crystalTorus' ? 0x312e81 : 0x0c4a6e,
      emissiveIntensity: isDark ? 0.42 : 0.24,
      roughness: 0.16,
      metalness: 0.12,
      clearcoat: 0.85,
      clearcoatRoughness: 0.08,
      transmission: 0.58,
      transparent: true,
      opacity: isDark ? 0.68 : 0.5,
    });
    disposableMaterials.push(bodyMat);

    // Fine wireframe overlay
    const wireMat = new THREE.MeshBasicMaterial({
      color: isDark ? 0x93c5fd : 0x3b82f6,
      wireframe: true,
      transparent: true,
      opacity: isDark ? 0.3 : 0.18,
      blending: THREE.AdditiveBlending,
    });
    disposableMaterials.push(wireMat);

    let ring1Mesh = null;
    let ring2Mesh = null;

    if (shapeType === 'crystalTorus') {
      const geo = new THREE.TorusKnotGeometry(1.25, 0.38, 128, 32, 2, 3);
      disposableGeometries.push(geo);

      const mesh = new THREE.Mesh(geo, bodyMat);
      const wire = new THREE.Mesh(geo, wireMat);
      wire.scale.setScalar(1.015);

      masterGroup.add(mesh);
      masterGroup.add(wire);
    } else {
      const coreGeo = new THREE.IcosahedronGeometry(0.85, 2);
      coreGeo.computeVertexNormals();
      disposableGeometries.push(coreGeo);
      const coreMesh = new THREE.Mesh(coreGeo, bodyMat);
      masterGroup.add(coreMesh);

      const ring1Geo = new THREE.TorusGeometry(1.48, 0.05, 16, 72);
      disposableGeometries.push(ring1Geo);
      ring1Mesh = new THREE.Mesh(ring1Geo, wireMat);
      ring1Mesh.rotation.x = Math.PI / 4;
      masterGroup.add(ring1Mesh);

      const ring2Geo = new THREE.TorusGeometry(1.88, 0.045, 16, 72);
      disposableGeometries.push(ring2Geo);
      const ring2Mat = new THREE.MeshBasicMaterial({
        color: isDark ? 0xc084fc : 0x8b5cf6,
        wireframe: true,
        transparent: true,
        opacity: isDark ? 0.32 : 0.18,
        blending: THREE.AdditiveBlending,
      });
      disposableMaterials.push(ring2Mat);
      ring2Mesh = new THREE.Mesh(ring2Geo, ring2Mat);
      ring2Mesh.rotation.y = Math.PI / 3;
      masterGroup.add(ring2Mesh);
    }

    // Stardust
    const count = 90;
    const partGeo = new THREE.BufferGeometry();
    const partPos = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i += 3) {
      partPos[i] = (Math.random() - 0.5) * 6.5;
      partPos[i + 1] = (Math.random() - 0.5) * 6.5;
      partPos[i + 2] = (Math.random() - 0.5) * 3.5;
    }
    partGeo.setAttribute('position', new THREE.BufferAttribute(partPos, 3));
    disposableGeometries.push(partGeo);

    const partMat = new THREE.PointsMaterial({
      color: isDark ? 0x93c5fd : 0x60a5fa,
      size: 0.045,
      transparent: true,
      opacity: isDark ? 0.6 : 0.4,
      blending: THREE.AdditiveBlending,
    });
    disposableMaterials.push(partMat);

    const partSystem = new THREE.Points(partGeo, partMat);
    scene.add(partSystem);

    const observer = new IntersectionObserver(
      ([entry]) => {
        isVisible = entry.isIntersecting;
      },
      { threshold: 0.1 }
    );
    observer.observe(container);

    // 4. Smooth harmonic animation loop
    const clock = new THREE.Clock();

    const animate = () => {
      animId = requestAnimationFrame(animate);

      if (!isVisible) return;

      const delta = clock.getDelta();
      const t = clock.getElapsedTime();

      // Mouse damping
      mouse.currentX += (mouse.targetX - mouse.currentX) * 0.04;
      mouse.currentY += (mouse.targetY - mouse.currentY) * 0.04;

      // Harmonic multi-axis floating
      masterGroup.rotation.x = Math.sin(t * 0.35) * 0.24 + Math.cos(t * 0.22) * 0.12 + mouse.currentY * 0.3;
      masterGroup.rotation.y = t * 0.18 + Math.sin(t * 0.28) * 0.18 + mouse.currentX * 0.35;
      masterGroup.rotation.z = Math.cos(t * 0.26) * 0.14;

      masterGroup.position.y = Math.sin(t * 0.55) * 0.18;
      masterGroup.position.x = Math.cos(t * 0.42) * 0.08;

      const breathe = 1.0 + Math.sin(t * 0.7) * 0.03;
      masterGroup.scale.setScalar(breathe);

      if (ring1Mesh && ring2Mesh) {
        ring1Mesh.rotation.z += delta * 0.45;
        ring1Mesh.rotation.x += delta * 0.3;
        ring2Mesh.rotation.y += delta * 0.4;
        ring2Mesh.rotation.z -= delta * 0.25;
      }

      partSystem.rotation.y -= delta * 0.06;

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      if (animId) cancelAnimationFrame(animId);
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
      window.removeEventListener('mousemove', handleMouseMove);

      disposableGeometries.forEach((g) => g.dispose());
      disposableMaterials.forEach((m) => m.dispose());
      renderer.dispose();
    };
  }, [shapeType, resolvedTheme]);

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 overflow-hidden pointer-events-none select-none ${className}`}
    >
      <canvas ref={canvasRef} className="w-full h-full block" />

      {/* Atmospheric Vignette & Soft Gradient Glow */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_50%,transparent_30%,hsl(var(--background)/0.8)_100%)] pointer-events-none" />

      {/* Subtle tech dot matrix */}
      <div className="absolute inset-0 bg-[radial-gradient(hsl(var(--primary)/0.12)_1px,transparent_1px)] bg-[size:3.5rem_3.5rem] opacity-40 pointer-events-none" />
    </div>
  );
}
