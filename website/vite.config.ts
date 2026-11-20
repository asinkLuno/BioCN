import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { visualizer } from 'rollup-plugin-visualizer';

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // 发布页部署在 GitHub Pages 的项目路径（/bioCN/）下；dev 不挂子路径，相对路径同时兼容自定义域名。
  base: command === 'build' ? './' : '/',
  plugins: [
    react(),
    tailwindcss(),
    // `ANALYZE=1 yarn build` 时输出 dist/stats.html（模块体积占比），平时零开销
    // @ts-expect-error config 脚本环境无 node 类型，process 可用
    ...(process.env.ANALYZE
      ? [
          visualizer({
            filename: 'dist/stats.html',
            gzipSize: true,
            brotliSize: true,
          }),
        ]
      : []),
  ],
  build: { target: 'es2022' },
}));
