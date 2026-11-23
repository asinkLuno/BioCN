import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ArrowDownToLine from 'lucide-react/icons/arrow-down-to-line';
import Code2 from 'lucide-react/icons/code-2';
import Moon from 'lucide-react/icons/moon';
import Sun from 'lucide-react/icons/sun';
import { HeroBrandLockup } from './components/HeroTitle';
import {
  BenchmarkTable,
  DEMO_PARAGRAPHS,
  Paragraph,
  SvoLegend,
  platformMeta,
  platformOrder,
  type Platform,
} from './showcase';
import './index.css';

type Theme = 'light' | 'dark';
const THEME_STORAGE_KEY = 'biocn-theme';

function readInitialTheme(): Theme {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
  }
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Storage unavailable
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme, persist: boolean) {
  document.documentElement.setAttribute('data-theme', theme);
  const metaColor = theme === 'dark' ? '#171614' : '#fcfbf8';
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.setAttribute('content', metaColor);
  });
  if (persist) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage unavailable
    }
  }
}

// 发布元数据由 CI 的 scripts/pages-release.mjs 从 GitHub Releases 生成并写进部署目录；
// 这里运行时读取并校验，不通过校验的数据一律退回到兜底视图。
const base = import.meta.env.BASE_URL;
const repository = 'https://github.com/asinkLuno/BioCN';
const downloadPrefix = `${repository}/releases/download/`;

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
function DemoPanels() {
  const [colored, setColored] = useState(true);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[0.95rem] font-semibold tracking-tight">仿生阅读是什么样？</h2>
        <label className="label cursor-pointer gap-2 p-0">
          <span className="text-xs font-medium text-base-content/75">仿生阅读</span>
          <input
            type="checkbox"
            className="toggle toggle-primary toggle-sm"
            checked={colored}
            aria-label="仿生阅读开关"
            onChange={(event) => setColored(event.target.checked)}
          />
        </label>
      </div>
      <div
        aria-hidden={!colored}
        className={`flex flex-wrap items-center gap-1.5 transition-opacity duration-200 ${
          colored ? 'opacity-100' : 'opacity-35'
        }`}
      >
        <SvoLegend />
      </div>
      <article className="heti heti--serif demo-heti rounded-box border border-base-content/8 bg-base-100 px-4 py-3.5 sm:px-5 sm:py-4">
        {DEMO_PARAGRAPHS.filter((paragraph) => paragraph.colored === colored).map(
          (paragraph, index) => (
            <Paragraph key={index} html={paragraph.text} colored={paragraph.colored} />
          ),
        )}
      </article>
    </div>
  );
}

function BenchmarkSection() {
  return (
    <section
      id="benchmark"
      aria-labelledby="benchmark-title"
      className="scroll-mt-20 space-y-6 border-t border-base-content/8 pt-12 sm:pt-16"
    >
      <div className="space-y-2.5">
        <h2 id="benchmark-title" className="text-2xl font-semibold tracking-tight sm:text-[1.65rem]">
          性能参考
        </h2>
        <div className="heti prose-heti max-w-2xl text-[0.95rem] leading-relaxed text-base-content/70 sm:text-base">
          <p>
            全流程本地 CPU 运行，不依赖显卡或云端接口。安装后可在应用设置中按需选择「省流」或「高精度」模型；以下为整本 107 万字《红楼梦》（137 章、42,961 唯一句）的实测数据，实际耗时视设备 CPU 性能而定。
          </p>
        </div>
      </div>

      <div className="card border border-base-content/8 bg-base-200/50">
        <div className="card-body p-3 sm:p-5">
          <BenchmarkTable />
        </div>
      </div>
    </section>
  );
}

function PlatformDownloads({ downloads }: { downloads: Download[] }) {
  return (
    <div className="grid gap-3.5 sm:grid-cols-2 sm:gap-4">
      {platformOrder.map((platform) => {
        const files = downloads.filter((download) => download.platform === platform);
        const meta = platformMeta[platform];
        const Icon = meta.icon;
        return (
          <div key={platform} className="card border border-base-content/8 bg-base-100">
            <div className="card-body gap-3 p-4 sm:p-5">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Icon aria-hidden="true" className="size-4 text-primary" />
                  <h3 className="text-sm font-semibold sm:text-base">{meta.label}</h3>
                </div>
                <p className="text-xs text-base-content/60 sm:text-sm">{meta.hint}</p>
              </div>
              <div className="flex flex-col gap-2">
                {files.map((file, index) => (
                  <a
                    key={file.download_url}
                    className={`btn btn-block btn-sm sm:btn-md ${index === 0 ? 'btn-primary' : 'btn-outline'}`}
                    href={file.download_url}
                    download={file.name}
                    title={file.name}
                  >
                    <ArrowDownToLine aria-hidden="true" className="size-4" />
                    下载 {formatLabel(file.name)}
                    <span className="ml-auto text-xs opacity-70 tabular-nums">
                      {formatSize(file.size)}
                    </span>
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

function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (next: Theme) => void }) {
  return (
    <div
      role="group"
      aria-label="外观模式"
      className="join rounded-field border border-base-content/10 bg-base-200/80 p-0.5"
    >
      <button
        type="button"
        className={`btn join-item btn-xs h-7 min-h-7 gap-1 border-0 px-2 ${
          theme === 'light'
            ? 'bg-primary/15 font-medium text-primary'
            : 'btn-ghost text-base-content/60 hover:text-base-content'
        }`}
        aria-label="浅色模式"
        aria-pressed={theme === 'light'}
        title="浅色模式"
        onClick={() => onChange('light')}
      >
        <Sun aria-hidden="true" className="size-3.5" />
        <span className="hidden md:inline">浅色</span>
      </button>
      <button
        type="button"
        className={`btn join-item btn-xs h-7 min-h-7 gap-1 border-0 px-2 ${
          theme === 'dark'
            ? 'bg-primary/15 font-medium text-primary'
            : 'btn-ghost text-base-content/60 hover:text-base-content'
        }`}
        aria-label="深色模式"
        aria-pressed={theme === 'dark'}
        title="深色模式"
        onClick={() => onChange('dark')}
      >
        <Moon aria-hidden="true" className="size-3.5" />
        <span className="hidden md:inline">深色</span>
      </button>
    </div>
  );
}

type ReleaseNoteBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'changelog'; label: string; url: string };

const versionTitleRe = /^(?:✨\s*)?v?\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?\s*更新内容$/;
const fullChangelogRe =
  /^\*{0,2}Full Changelog\*{0,2}\s*:\s*(?:\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/\S+))$/i;

function inlineNoteText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .trim();
}

function parseReleaseNotes(markdown: string): ReleaseNoteBlock[] {
  const blocks: ReleaseNoteBlock[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const changelog = fullChangelogRe.exec(line);
    if (changelog) {
      const url = changelog[2] ?? changelog[3];
      if (url?.startsWith('https://github.com/')) {
        blocks.push({ kind: 'changelog', label: '查看完整变更对比', url });
        continue;
      }
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const text = inlineNoteText(heading[1]);
      if (text && !versionTitleRe.test(text)) {
        blocks.push({ kind: 'heading', text });
      }
      continue;
    }

    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      const text = inlineNoteText(item[1]);
      if (!text) continue;
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'list') {
        last.items.push(text);
      } else {
        blocks.push({ kind: 'list', items: [text] });
      }
      continue;
    }

    const text = inlineNoteText(line);
    if (text) {
      blocks.push({ kind: 'text', text });
    }
  }
  return blocks;
}

function ReleaseNotesView({ notes }: { notes: string }) {
  const blocks = parseReleaseNotes(notes);
  if (blocks.length === 0) return null;
  return (
    <div className="space-y-2">
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          return (
            <h3 key={`h-${index}`} className="pt-2 first:pt-0 text-sm font-medium text-base-content/90">
              {block.text}
            </h3>
          );
        }
        if (block.kind === 'list') {
          return (
            <ul
              key={`l-${index}`}
              className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-base-content/70"
            >
              {block.items.map((item, itemIndex) => (
                <li key={`i-${itemIndex}`} className="[overflow-wrap:anywhere]">
                  {item}
                </li>
              ))}
            </ul>
          );
        }
        if (block.kind === 'changelog') {
          return (
            <p key={`c-${index}`} className="pt-1 text-xs text-base-content/60">
              <a
                className="link link-hover text-primary"
                href={block.url}
                target="_blank"
                rel="noreferrer"
              >
                {block.label}
              </a>
            </p>
          );
        }
        return (
          <p
            key={`t-${index}`}
            className="text-sm leading-relaxed [overflow-wrap:anywhere] text-base-content/70"
          >
            {block.text}
          </p>
        );
      })}
    </div>
  );
}

function App() {
  const [release, setRelease] = useState<Release | null>(null);
  const [history, setHistory] = useState<Release[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    applyTheme(theme, false);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const onSystemChange = (event: MediaQueryListEvent) => {
      try {
        if (window.localStorage.getItem(THEME_STORAGE_KEY)) return;
      } catch {
        // Storage unavailable
      }
      setTheme(event.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', onSystemChange);
    return () => media.removeEventListener('change', onSystemChange);
  }, []);

  const selectTheme = (next: Theme) => {
    setTheme(next);
    applyTheme(next, true);
  };

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
    <div className="flex min-h-screen flex-col bg-base-100 text-base-content transition-colors duration-200">
      <header className="sticky top-0 z-30 border-b border-base-content/8 bg-base-100/90 backdrop-blur-md">
        <div className="navbar mx-auto min-h-14 max-w-5xl px-4 sm:px-6">
          <div className="navbar-start">
            <a className="btn btn-ghost btn-sm gap-2 px-2 text-base font-semibold tracking-tight" href={base} aria-label="BioCN 首页">
              <img src={`${base}brand/icon-128.png`} alt="" width={24} height={24} className="size-6" />
              BioCN
            </a>
          </div>
          <nav aria-label="主导航" className="navbar-end flex items-center gap-1 sm:gap-2">
            <a className="btn btn-ghost btn-sm font-normal" href="#benchmark">
              性能
            </a>
            <a className="btn btn-ghost btn-sm font-normal" href="#download">
              下载
            </a>
            <ThemeToggle theme={theme} onChange={selectTheme} />
            <a className="btn btn-outline btn-sm hidden gap-1.5 sm:inline-flex" href={repository}>
              <Code2 aria-hidden="true" className="size-4" /> GitHub
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 space-y-14 px-4 pb-16 sm:space-y-16 sm:px-6 sm:pb-24">
        <section
          aria-labelledby="intro-title"
          className="grid items-center gap-8 overflow-x-clip pt-8 sm:pt-12 lg:grid-cols-12 lg:gap-10 lg:pt-14"
        >
          <div className="lg:col-span-5">
            <HeroBrandLockup>
              <div className="flex flex-wrap items-center gap-3">
                <a className="btn btn-primary gap-2 px-5 whitespace-nowrap" href="#download">
                  <ArrowDownToLine aria-hidden="true" className="size-4" /> 下载 BioCN
                </a>
                <a className="btn btn-outline gap-2 px-5 whitespace-nowrap" href={repository}>
                  <Code2 aria-hidden="true" className="size-4" /> GitHub
                </a>
              </div>
            </HeroBrandLockup>
          </div>
          <div className="w-full lg:col-span-7">
            <div className="card border border-base-content/8 bg-base-200/75">
              <div className="card-body p-4 sm:p-5">
                <DemoPanels />
              </div>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="why-title"
          className="grid gap-4 border-t border-base-content/8 pt-12 sm:pt-16 lg:grid-cols-12 lg:gap-10"
        >
          <h2
            id="why-title"
            className="text-2xl font-semibold tracking-tight sm:text-[1.65rem] lg:col-span-4"
          >
            为什么做这个应用？
          </h2>
          <div className="heti prose-heti max-w-2xl text-[0.95rem] leading-[1.8] text-base-content/75 sm:text-base lg:col-span-8">
            <p>
              英文世界里有一种“仿生阅读”，通过加粗每个单词的开头来帮眼睛锚定重心，对 ADHD 和容易分心的读者特别友好。
            </p>
            <p>
              我们也想把这种体验带给中文读者，但一上手就遇到了麻烦：中文没有单词的边界，直接加粗字首根本行不通。于是我们换了个思路——用传统的自然语言处理方法，借助 HanLP 做句法分析，把每句话的主谓宾染上颜色。
            </p>
          </div>
        </section>

        <BenchmarkSection />

        <section
          id="download"
          aria-labelledby="download-title"
          className="scroll-mt-20 border-t border-base-content/8 pt-12 sm:pt-16"
        >
          <div className="card border border-base-content/8 bg-base-200/50">
            <div className="card-body gap-5 p-5 sm:gap-6 sm:p-7">
              <h2 id="download-title" className="text-2xl font-semibold tracking-tight sm:text-[1.65rem]">
                下载 BioCN
              </h2>

              {status === 'loading' ? (
                <div className="space-y-4" aria-label="正在读取最新版本">
                  <div className="skeleton h-7 w-36" />
                  <div className="grid gap-4 sm:grid-cols-2">
                    {platformOrder.map((platform) => (
                      <div key={platform} className="skeleton h-40 w-full" />
                    ))}
                  </div>
                </div>
              ) : null}

              {release ? (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="badge badge-primary badge-soft badge-md font-medium">
                      v{release.version}
                    </span>
                    <p className="text-sm text-base-content/65">
                      发布于 {formatDate(release.published_at)}
                    </p>
                  </div>
                  <PlatformDownloads downloads={release.downloads} />
                </div>
              ) : null}

              {status === 'error' ? (
                <div role="alert" className="alert alert-error alert-soft">
                  <span>暂时无法读取 GitHub 发布信息。</span>
                  <a className="btn btn-outline btn-sm" href={`${repository}/releases/latest`}>
                    前往 GitHub Releases
                  </a>
                </div>
              ) : null}

              {history.length > 1 ? (
                <details className="collapse collapse-arrow border border-base-content/8 bg-base-100">
                  <summary className="collapse-title text-sm font-medium">历史版本</summary>
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
                            <td className="tabular-nums">v{item.version}</td>
                            <td className="tabular-nums">{formatDate(item.published_at)}</td>
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
                <div id="release-notes" className="space-y-2.5 border-t border-base-content/8 pt-4">
                  <p className="text-sm font-medium">v{release.version} 更新内容</p>
                  <ReleaseNotesView notes={release.notes} />
                </div>
              ) : null}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-base-content/8 bg-base-200/40">
        <div className="mx-auto flex max-w-5xl items-center justify-center px-4 py-6 text-center text-sm text-base-content/60 sm:px-6">
          <p>
            © 2026 BioCN contributors · GPL-3.0-or-later
            {' · '}
            <a className="link link-hover" href={`${repository}/blob/main/LICENSE`}>
              GPL-3.0
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
