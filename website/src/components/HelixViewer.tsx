import { useRef, useEffect } from 'react';
import * as THREE from 'three';

interface HelixViewerProps {
  size?: number;
  speed?: number;
}

export function HelixViewer({ size = 200, speed = 1 }: HelixViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Scene setup
    const scene = new THREE.Scene();
    // 透明画布，跟随页面主题（浅色/深色都直接透出背景）
    scene.background = null;
    scene.fog = null;
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    camera.position.z = 105;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      // WebGL 不可用（如浏览器关闭硬件加速、无 GPU 环境）——THREE 构造器会直接抛错，
      // 不接住会卸载整棵 React 树导致全页白屏。退回静态 CSS 动画 SVG（同一标志）。
      const img = document.createElement('img');
      img.src = `${import.meta.env.BASE_URL}brand/helix-launch.svg`;
      img.alt = '';
      img.width = size;
      img.height = size;
      containerRef.current.replaceChildren(img);
      return;
    }
    renderer.setSize(size, size);
    renderer.setPixelRatio(window.devicePixelRatio);
    rendererRef.current = renderer;
    containerRef.current.appendChild(renderer.domElement);

    // Lighting setup
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambientLight);
    
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.55);
    dirLight.position.set(15, 15, 25);
    dirLight.shadow.mapSize.width = 512;
    dirLight.shadow.mapSize.height = 512;
    scene.add(dirLight);

    // Main helix group
    const helix = new THREE.Group();
    scene.add(helix);

    // Helix parameters
    const turns = 2.4;
    const height = 90;
    const radius = 16;
    const segments = 300;

    const createStrand = (phaseOffset: number, color: number) => {
      const points: THREE.Vector3[] = [];
      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const angle = turns * Math.PI * 2 * t + phaseOffset;
        const x = radius * Math.cos(angle);
        const y = -height / 2 + height * t;
        const z = radius * Math.sin(angle);
        points.push(new THREE.Vector3(x, y, z));
      }

      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      
      // Use LineBasicMaterial with higher linewidth
      const material = new THREE.LineBasicMaterial({
        color,
        linewidth: 8,
        fog: true,
      });

      const line = new THREE.Line(geometry, material);
      return line;
    };

    // Create both strands (phase offset by π = 180°)
    const strand1 = createStrand(0, 0xda854b); // Amber
    const strand2 = createStrand(Math.PI, 0x4da78a); // Jade
    helix.add(strand1);
    helix.add(strand2);

    // Create connecting rungs (purple)
    // Create connecting rungs (purple)
    const rungCount = 5;

    for (let i = 0; i < rungCount; i++) {
      const t = (i + 1) / (rungCount + 1);
      const angle1 = turns * Math.PI * 2 * t;
      const angle2 = angle1 + Math.PI;

      const p1 = new THREE.Vector3(
        radius * Math.cos(angle1),
        -height / 2 + height * t,
        radius * Math.sin(angle1)
      );
      const p2 = new THREE.Vector3(
        radius * Math.cos(angle2),
        -height / 2 + height * t,
        radius * Math.sin(angle2)
      );

      const geometry = new THREE.BufferGeometry().setFromPoints([p1, p2]);
      const material = new THREE.LineBasicMaterial({
        color: 0x79739e,
        linewidth: 5,
      });

      const line = new THREE.Line(geometry, material);
      helix.add(line);
    }
    // Animation loop with proper rotation direction
    let rafId = 0;
    let previousFrame = 0;
    const rotationSpeed = (speed * Math.PI * 2) / 240;
    const animate = (now: number) => {
      rafId = requestAnimationFrame(animate);
      const elapsed = previousFrame ? Math.min(now - previousFrame, 50) : 0;
      previousFrame = now;
      helix.rotation.y += (rotationSpeed * elapsed) / 1000;
      const phase = (helix.rotation.y % (Math.PI * 2)) / (Math.PI * 2);
      renderer.render(scene, camera);
    };

    rafId = requestAnimationFrame(animate);

    // Cleanup
    return () => {
      cancelAnimationFrame(rafId);
      renderer.dispose();
      containerRef.current?.removeChild(renderer.domElement);
    };
  }, [size, speed]);

  return (
    <div
      ref={containerRef}
      style={{
        display: 'inline-grid', placeItems: 'center', flex: '0 0 auto',
        width: size,
        height: size,
      }}
    />
  );
}
