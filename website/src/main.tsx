import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import ArrowDownToLine from 'lucide-react/icons/arrow-down-to-line';
import Code2 from 'lucide-react/icons/code-2';
import Laptop from 'lucide-react/icons/laptop';
import Monitor from 'lucide-react/icons/monitor';
import Smartphone from 'lucide-react/icons/smartphone';
import Terminal from 'lucide-react/icons/terminal';
import type { LucideIcon } from 'lucide-react';


// HelixViewer 内含 three.js（~160KB gzip），拆成独立 chunk 首屏不阻塞解析：
// 静态 import 会让 hero 上方整页等它下载完才可交互。
const HelixViewer = lazy(() =>
  import('./components/HelixViewer').then((m) => ({ default: m.HelixViewer })),
);
import './index.css';

// 发布元数据由 CI 的 scripts/pages-release.mjs 从 GitHub Releases 生成并写进部署目录；
// 这里运行时读取并校验，不通过校验的数据一律退回到兜底视图。
const base = import.meta.env.BASE_URL;
const repository = 'https://github.com/asinkLuno/BioCN';
const downloadPrefix = `${repository}/releases/download/`;

type Platform = 'android' | 'windows' | 'macos' | 'linux';
type Download = {
  name: string;
  platform: Platform;
  size: number;
  download_url: string;
};
type Release = {
  version: string;
  published_at: string;
  notes: string;
  downloads: Download[];
};

const platformOrder: Platform[] = ['android', 'windows', 'macos', 'linux'];

const platformMeta: Record<Platform, { label: string; hint: string; icon: LucideIcon }> = {
  android: { label: 'Android', hint: 'Android 7.0+ · arm64-v8a', icon: Smartphone },
  windows: { label: 'Windows', hint: 'Windows 10/11 · x64', icon: Monitor },
  macos: { label: 'macOS', hint: 'macOS 13.0+ · Apple Silicon', icon: Laptop },
  linux: { label: 'Linux', hint: 'x86_64', icon: Terminal },
};

// 演示文本出自鲁迅《故事新编·补天》。着色由仓库里的真实分析器生成
// （src-tauri/examples/svodemo.rs），不是手标的，升级模型后可用它重新生成。
const DEMO_PARAGRAPHS: { text: string; colored: boolean }[] = [
  {
    colored: false,
    text: '女娲忽然醒来了。',
  },
  {
    colored: true,
    text: '<span class="svo-subject font-medium">女娲</span>忽然<span class="svo-predicate font-medium">醒来</span>了。',
  },
  {
    colored: false,
    text: '伊似乎是从梦中惊醒的，然而已经记不清做了什么梦；只是很懊恼，觉得有什么不足，又觉得有什么太多了。煽动的和风，暖暾的将伊的气力吹得弥漫在宇宙里。',
  },
  {
    colored: true,
    text: '<span class="svo-subject font-medium">伊</span>似乎是从梦中<span class="svo-predicate font-medium">惊醒</span>的，然而已经<span class="svo-predicate font-medium">记</span>不<span class="svo-predicate font-medium">清做</span>了什么<span class="svo-object font-medium">梦</span>；只是很<span class="svo-predicate font-medium">懊恼</span>，<span class="svo-predicate font-medium">觉得有</span>什么<span class="svo-object font-medium">不足</span>，又<span class="svo-predicate font-medium">觉得有</span><span class="svo-subject font-medium">什么</span>太<span class="svo-predicate font-medium">多</span>了。煽动的<span class="svo-subject font-medium">和风</span>，<span class="svo-predicate font-medium">暖</span>暾的将伊的<span class="svo-object font-medium">气力</span><span class="svo-predicate font-medium">吹</span>得<span class="svo-predicate font-medium">弥漫</span>在宇宙里。',
  },
  {
    colored: false,
    text: '伊揉一揉自己的眼睛。',
  },
  {
    colored: true,
    text: '<span class="svo-subject font-medium">伊</span><span class="svo-predicate font-medium">揉</span>一<span class="svo-predicate font-medium">揉</span>自己的<span class="svo-object font-medium">眼睛</span>。',
  },
  {
    colored: false,
    text: '粉红的天空中，曲曲折折的漂着许多条石绿色的浮云，星便在那后面忽明忽灭的䀹眼。天边的血红的云彩里有一个光芒四射的太阳，如流动的金球包在荒古的熔岩中；那一边，却是一个生铁一般的冷而且白的月亮。然而伊并不理会谁是下去，和谁是上来。',
  },
  {
    colored: true,
    text: '粉红的天空中，曲曲折折的<span class="svo-predicate font-medium">漂</span>着许多条石绿色的<span class="svo-object font-medium">浮云</span>，<span class="svo-subject font-medium">星</span>便在那后面忽明忽灭的<span class="svo-object font-medium">䀹眼</span>。天边的血红的云彩里<span class="svo-predicate font-medium">有</span>一个光芒四射的<span class="svo-object font-medium">太阳</span>，如流动的金球<span class="svo-predicate font-medium">包</span>在荒古的熔岩中；那一边，却<span class="svo-predicate font-medium">是</span>一个生铁一般的冷而且白的<span class="svo-object font-medium">月亮</span>。然而<span class="svo-subject font-medium">伊</span>并不<span class="svo-predicate font-medium">理会</span><span class="svo-subject font-medium">谁</span>是<span class="svo-predicate font-medium">下去</span>，和谁是上来。',
  },
  {
    colored: false,
    text: '地上都嫩绿了，便是不很换叶的松柏也显得格外的娇嫩。',
  },
  {
    colored: true,
    text: '<span class="svo-subject font-medium">地上</span>都<span class="svo-predicate font-medium">嫩绿</span>了，便是不很换叶的<span class="svo-subject font-medium">松柏</span>也显得格外的<span class="svo-predicate font-medium">娇嫩</span>。',
  },
];
function validDownload(value: unknown): value is Download {
  if (!value || typeof value !== 'object') return false;
  const download = value as Record<string, unknown>;
  return (
    typeof download.name === 'string' &&
    download.name.startsWith('BioCN') &&
    !download.name.includes('..') &&
    platformOrder.includes(download.platform as Platform) &&
    typeof download.size === 'number' &&
    download.size > 0 &&
    typeof download.download_url === 'string' &&
    download.download_url.startsWith(downloadPrefix) &&
    download.download_url.endsWith(download.name)
  );
}

function validRelease(value: unknown): value is Release {
  if (!value || typeof value !== 'object') return false;
  const release = value as Record<string, unknown>;
  return (
    typeof release.version === 'string' &&
    /^\d+\.\d+\.\d+$/.test(release.version) &&
    typeof release.published_at === 'string' &&
    Number.isFinite(Date.parse(release.published_at)) &&
    typeof release.notes === 'string' &&
    Array.isArray(release.downloads) &&
    release.downloads.length > 0 &&
    release.downloads.every(validDownload)
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-CN');
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 按钮上用短标签，避免长文件名把移动端卡片撑出横向滚动。
function formatLabel(name: string): string {
  if (name.endsWith('.apk')) return 'APK 安装包';
  if (name.endsWith('.exe')) return 'EXE 安装程序';
  if (name.endsWith('.msi')) return 'MSI 安装包';
  if (name.endsWith('.dmg')) return 'DMG 映像';
  if (name.endsWith('.deb')) return 'DEB 包';
  if (name.endsWith('.rpm')) return 'RPM 包';
  return name;
}
function Paragraph({ html, colored }: { html: string; colored: boolean }) {
  if (!colored) {
    return <p className="font-serif text-lg leading-loose text-base-content/80">{html}</p>;
  }
  return <p className="font-serif text-lg leading-loose" dangerouslySetInnerHTML={{ __html: html }} />;
}

function DemoPanels() {
  const [colored, setColored] = useState(true);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="label cursor-pointer gap-2">
          <span className="font-medium">仿生阅读</span>
          <input
            type="checkbox"
            className="toggle toggle-primary"
            checked={colored}
            aria-label="仿生阅读开关"
            onChange={(event) => setColored(event.target.checked)}
          />
        </label>
        {colored ? <SvoLegend /> : null}
      </div>
      <div className="space-y-1.5 rounded-lg bg-base-100 px-4 py-3 ring-1 ring-base-300">
        {DEMO_PARAGRAPHS.filter((paragraph) => paragraph.colored === colored).map(
          (paragraph, index) => (
            <Paragraph key={index} html={paragraph.text} colored={paragraph.colored} />
          ),
        )}
      </div>
    </div>
  );
}

function SvoLegend() {
  return (
    <div className="flex flex-wrap gap-2">
      <span className="badge badge-outline gap-1.5">
        <span className="svo-subject">主语</span>
      </span>
      <span className="badge badge-outline gap-1.5">
        <span className="svo-predicate">谓语</span>
      </span>
      <span className="badge badge-outline gap-1.5">
        <span className="svo-object">宾语</span>
      </span>
    </div>
  );
}

function PlatformDownloads({ downloads }: { downloads: Download[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {platformOrder.map((platform) => {
        const files = downloads.filter((download) => download.platform === platform);
        const meta = platformMeta[platform];
        const Icon = meta.icon;
        return (
          <div key={platform} className="card bg-base-200 shadow-sm">
            <div className="card-body gap-3 p-5">
              <div className="flex items-center gap-2">
                <Icon aria-hidden="true" className="size-5" />
                <h3 className="font-medium">{meta.label}</h3>
              </div>
              <p className="text-sm text-base-content/70">{meta.hint}</p>
              <div className="flex flex-col gap-2">
                {files.map((file, index) => (
                  <a
                    key={file.download_url}
                    className={`btn btn-block ${index === 0 ? 'btn-primary' : 'btn-outline'}`}
                    href={file.download_url}
                    download={file.name}
                    title={file.name}
                  >
                    <ArrowDownToLine aria-hidden="true" />
                    下载 {formatLabel(file.name)}
                    <span className="ml-auto text-xs opacity-70">{formatSize(file.size)}</span>
                  </a>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function App() {
  const [release, setRelease] = useState<Release | null>(null);
  const [history, setHistory] = useState<Release[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let disposed = false;
    async function loadLatest() {
      try {
        const response = await fetch(`${base}latest.json`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Latest release unavailable');
        const value: unknown = await response.json();
        if (!validRelease(value)) throw new Error('Invalid release metadata');
        if (!disposed) {
          setRelease(value);
          setStatus('ready');
        }
      } catch {
        if (!disposed) setStatus('error');
      }
    }
    void loadLatest();
    void fetch(`${base}releases.json`, { signal: controller.signal, cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : []))
      .then((value: unknown) => {
        if (!disposed && Array.isArray(value)) setHistory(value.filter(validRelease));
      })
      .catch(() => {});
    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  return (
    <div className="min-h-screen bg-base-100 text-base-content">
      <header className="navbar mx-auto max-w-7xl px-4 sm:px-6 2xl:max-w-[96rem]">
        <div className="navbar-start">
          <a className="btn btn-ghost px-2 text-lg font-semibold" href={base} aria-label="BioCN 首页">
            <img src={`${base}brand/icon-128.png`} alt="" width={28} height={28} className="size-7" />
            BioCN
          </a>
        </div>
        <nav aria-label="主导航" className="navbar-end flex items-center gap-2">
          <a className="btn btn-ghost" href="#download">
            下载
          </a>
          <a className="btn btn-outline btn-sm hidden sm:flex" href={repository}>
            <Code2 aria-hidden="true" /> GitHub
          </a>
        </nav>
      </header>

      <main className="mx-auto max-w-7xl space-y-20 px-4 pb-12 sm:px-6 sm:pb-20 2xl:max-w-[96rem]">
        <section aria-labelledby="intro-title" className="hero py-10 md:py-16">
          <div className="hero-content flex-col items-start gap-12 lg:flex-row lg:items-center lg:gap-16">
            <div className="hero-brand-lockup max-w-xl">
              <div className="hero-brand-mark" aria-hidden="true">
                {/* 拆 chunk 的加载占位：透明方块，布局不跳（尺寸已由 hero-brand-mark 固定） */}
                <Suspense fallback={<div style={{ width: 160, height: 160 }} />}>
                  <HelixViewer size={160} speed={60} />
                </Suspense>
              </div>
              <div className="space-y-7">
                <h1
                  id="intro-title"
                  className="space-y-2 font-semibold"
                >
                  <span className="block text-[2.75rem] leading-tight tracking-tight sm:text-6xl"><span className="text-[#1b9e77]">Bio</span><span className="text-[#7570b3]">CN</span></span>
                  <span className="block text-xl leading-snug tracking-tight text-base-content/70 sm:text-2xl">中文仿生阅读</span>
                </h1>
                <div className="flex flex-wrap gap-3">
                  <a className="btn btn-primary btn-lg" href="#download">
                    <ArrowDownToLine aria-hidden="true" /> 下载 BioCN
                  </a>
                  <a className="btn btn-outline btn-lg" href={repository}>
                    <Code2 aria-hidden="true" /> GitHub
                  </a>
                </div>
              </div>
            </div>
            <div className="flex w-full max-w-md flex-col items-center gap-6">
              <div className="card w-full bg-base-200 shadow-xl">
                <div className="card-body gap-4">
                  <h2 className="card-title text-base">仿生阅读是什么样？</h2>
                  <DemoPanels />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section aria-labelledby="why-title" className="space-y-4">
          <h2 id="why-title" className="text-3xl font-semibold tracking-tight">
            为什么做这个应用？
          </h2>
          <p className="max-w-2xl text-lg leading-relaxed text-base-content/70">
            英文仿生阅读是加粗每个单词的开头；中文没有单词的边界，BioCN
            改用句法分析，把每句的主谓宾染上颜色——为 ADHD 与容易分心的读者设计，眼睛循着颜色，长句里也抓得住主线。
          </p>
          <p className="max-w-2xl text-lg leading-relaxed text-base-content/70">完全离线运行。</p>
        </section>
        <section id="download" aria-labelledby="download-title" className="scroll-mt-8">
          <div className="card bg-base-100 shadow-sm ring-1 ring-base-200">
            <div className="card-body gap-6">
              <div className="space-y-2">
                <h2 id="download-title" className="card-title text-3xl">
                  下载 BioCN
                </h2>
                <p className="leading-relaxed text-base-content/70">
                  所有安装包发布在 GitHub Releases。
                </p>
              </div>

              {status === 'loading' ? (
                <div className="space-y-4" aria-label="正在读取最新版本">
                  <div className="skeleton h-8 w-40" />
                  <div className="grid gap-4 sm:grid-cols-2">
                    {platformOrder.map((platform) => (
                      <div key={platform} className="skeleton h-44 w-full" />
                    ))}
                  </div>
                </div>
              ) : null}

              {release ? (
                <div className="space-y-6">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="badge badge-primary badge-lg">v{release.version}</span>
                    <p className="text-sm text-base-content/70">
                      发布于 {formatDate(release.published_at)}
                    </p>
                  </div>
                  <PlatformDownloads downloads={release.downloads} />
                </div>
              ) : null}

              {status === 'error' ? (
                <div role="alert" className="alert alert-error">
                  <span>暂时无法读取 GitHub 发布信息。</span>
                  <a className="btn btn-outline btn-sm" href={`${repository}/releases/latest`}>
                    前往 GitHub Releases
                  </a>
                </div>
              ) : null}


              {history.length > 1 ? (
                <details className="collapse collapse-arrow bg-base-200">
                  <summary className="collapse-title">历史版本</summary>
                  <div className="collapse-content">
                    <table className="table table-sm">
                      <thead>
                        <tr>
                          <th>版本</th>
                          <th>发布日期</th>
                          <th>下载</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.map((item) => (
                          <tr key={item.version}>
                            <td>v{item.version}</td>
                            <td>{formatDate(item.published_at)}</td>
                            <td>
                              <a
                                className="link link-hover text-primary"
                                href={`${repository}/releases/tag/v${item.version}`}
                              >
                                GitHub Release
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ) : null}

              {release?.notes ? (
                <div className="space-y-2">
                  <p className="font-medium">v{release.version} 更新内容</p>
                  {/* notes 来自 Release 说明，可能带长链接；anywhere 保证 token 内也能断行，不撑破移动端。 */}
                  <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-base-content/70">
                    {release.notes.replace(/^#{1,6} /gm, '')}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      </main>

      <footer className="footer footer-center bg-base-200 text-base-content/70 sm:p-10">
        <aside>
          <p>
            © 2026 BioCN contributors · GPL-3.0-or-later
            {' · '}
            <a className="link link-hover" href={`${repository}/blob/main/LICENSE`}>
              GPL-3.0
            </a>
          </p>
        </aside>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
