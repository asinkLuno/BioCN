import { createRoot } from 'react-dom/client';
import { HelixViewer } from './components/HelixViewer';
import './index.css';

// 独立演示页：全屏居中只展示螺旋动效。构建后为 /bioCN/helix.html。
createRoot(document.getElementById('root')!).render(
  <main className="flex min-h-screen items-center justify-center bg-base-100">
    <HelixViewer size={420} />
  </main>,
);
