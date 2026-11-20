import { useRef, useEffect } from 'react';
import * as THREE from 'three';

interface HelixViewerProps {
  size?: number;
  speed?: number;
}

export function HelixViewer({ size = 200, speed = 1 }: HelixViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Scene setup
    const scene = new THREE.Scene();
    // 透明画布，跟随页面主题（浅色/深色都直接透出背景）
    scene.background = null;
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
    containerRef.current.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.55);
    dirLight.position.set(15, 15, 25);
    scene.add(dirLight);

    // Main helix group
    const helix = new THREE.Group();
    scene.add(helix);

    // Helix parameters
    const turns = 2.4;
    const height = 90;
    const radius = 16;
    const segments = 300;

    const tubeRadius = 0.9;
    const geometryAssets: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
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

      // 细圆柱管代替 Line：WebGL 里 linewidth 恒为 1px，两链交叠时只有后画
      // 的那条能赢；管子有真实体积，交叉处由深度测试裁决，旋转时绿、橙自然
      // 轮流压过对方。tubeRadius/radiusSegments 配合现有灯光可有立体感。
      const geometry = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(points),
        segments,
        tubeRadius,
        4,
        false
      );
      const material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.55,
        metalness: 0.05,
        fog: true,
      });

      geometryAssets.push({ geometry, material });
      return new THREE.Mesh(geometry, material);
    };

    // Create both strands (phase offset by π = 180°)
    helix.add(createStrand(0, 0xda854b)); // Amber
    helix.add(createStrand(Math.PI, 0x4da78a)); // Jade

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

      const dir = new THREE.Vector3().subVectors(p2, p1);
      const len = dir.length();

      // 横档也用细圆柱，粗细与链身（半径 0.9）成比例；openEnded 省掉两端
      // 盖片，端头本来就埋进链身的管子里。
      const geometry = new THREE.CylinderGeometry(0.45, 0.45, len, 4, 1, true);
      const material = new THREE.MeshStandardMaterial({
        color: 0x79739e,
        roughness: 0.55,
        metalness: 0.05,
        fog: true,
      });
      geometryAssets.push({ geometry, material });
      const rung = new THREE.Mesh(geometry, material);
      rung.position.copy(p1).addScaledVector(dir, 0.5);
      rung.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        dir.clone().normalize()
      );
      helix.add(rung);
    }
    const rotationSpeed = (speed * Math.PI * 2) / 240;
    let rafId = 0;
    let previousFrame = 0;
    const animate = (now: number) => {
      rafId = requestAnimationFrame(animate);
      const elapsed = previousFrame ? Math.min(now - previousFrame, 50) : 0;
      previousFrame = now;
      helix.rotation.y += (rotationSpeed * elapsed) / 1000;
      renderer.render(scene, camera);
    };

    rafId = requestAnimationFrame(animate);

    // Cleanup
    return () => {
      cancelAnimationFrame(rafId);
      renderer.dispose();
      geometryAssets.forEach(({ geometry, material }) => {
        geometry.dispose();
        material.dispose();
      });
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
