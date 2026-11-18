import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ command }) => ({
  // 发布页部署在 GitHub Pages 的项目路径（/bioCN/）下，相对路径同时兼容未来的自定义域名。
  base: command === 'build' ? './' : '/',
  plugins: [react(), tailwindcss()],
  build: { target: 'es2022' },
}));
