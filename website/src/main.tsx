import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ArrowDownToLine from 'lucide-react/icons/arrow-down-to-line';
import Code2 from 'lucide-react/icons/code-2';
import Laptop from 'lucide-react/icons/laptop';
import Monitor from 'lucide-react/icons/monitor';
import Moon from 'lucide-react/icons/moon';
import Smartphone from 'lucide-react/icons/smartphone';
import Sun from 'lucide-react/icons/sun';
import Terminal from 'lucide-react/icons/terminal';
import type { LucideIcon } from 'lucide-react';
import { HeroBrandLockup } from './components/HeroTitle';
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
  {
    colored: false,
    text: '桃红和青白色的斗大的杂花，在眼前还分明，到远处可就成为斑斓的烟霭了。',
  },
  {
    colored: true,
    text: '桃红和青白色的斗大的<span class="svo-subject font-medium">杂花</span>，在眼前还<span class="svo-predicate font-medium">分明</span>，到远处可就<span class="svo-predicate font-medium">成为</span>斑斓的<span class="svo-object font-medium">烟霭</span>了。',
  },
  {
    colored: false,
    text: '“唉唉，我从来没有这样的无聊过！”伊想着，猛然间站立起来了，擎上那非常圆满而精力洋溢的臂膊，向天打一个欠伸，天空便突然失了色，化为神异的肉红，暂时再也辨不出伊所在的处所。',
  },
  {
    colored: true,
    text: '“唉唉，<span class="svo-subject font-medium">我</span>从来没有这样的<span class="svo-predicate font-medium">无聊</span>过！”<span class="svo-subject font-medium">伊</span><span class="svo-predicate font-medium">想</span>着，猛然间<span class="svo-predicate font-medium">站立起来</span>了，擎上那非常圆满而精力洋溢的臂膊，向天<span class="svo-predicate font-medium">打</span>一个<span class="svo-object font-medium">欠</span><span class="svo-predicate font-medium">伸</span>，<span class="svo-subject font-medium">天空</span>便突然<span class="svo-predicate font-medium">失</span>了<span class="svo-object font-medium">色</span>，<span class="svo-predicate font-medium">化为</span>神异的<span class="svo-object font-medium">肉红</span>，暂时再也<span class="svo-predicate font-medium">辨</span>不<span class="svo-predicate font-medium">出</span>伊所在的<span class="svo-object font-medium">处所</span>。',
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
    return (
      <p className="text-[0.95rem] text-base-content/75 sm:text-base">
        {html}
      </p>
    );
  }
  return (
    <p
      className="text-[0.95rem] text-base-content/90 sm:text-base"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
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

function SvoLegend() {
  return (
    <div className="flex flex-wrap gap-1.5">
      <span className="badge badge-outline badge-sm border-base-content/15 bg-base-100/70">
        <span className="svo-subject font-medium">主语</span>
      </span>
      <span className="badge badge-outline badge-sm border-base-content/15 bg-base-100/70">
        <span className="svo-predicate font-medium">谓语</span>
      </span>
      <span className="badge badge-outline badge-sm border-base-content/15 bg-base-100/70">
        <span className="svo-object font-medium">宾语</span>
      </span>
    </div>
  );
}

const MODEL_BENCHMARKS = [
  {
    name: '省流 (INT8)',
    recommended: true,
    size: '64.3 MB',
    throughput: '361 句/秒',
    wholeBook: '1 分 59 秒',
    peakMemory: '约 200 MB',
  },
  {
    name: '高精度 (FP16)',
    recommended: false,
    size: '74.6 MB',
    throughput: '111 句/秒',
    wholeBook: '6 分 26 秒',
    peakMemory: '约 377 MB',
  },
] as const;

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
          <div className="overflow-x-auto">
            <table className="table table-sm sm:table-md">
              <thead>
                <tr className="border-base-content/10 text-xs font-medium text-base-content/60">
                  <th>模型版本</th>
                  <th className="text-right">下载体积</th>
                  <th className="text-right">分析吞吐</th>
                  <th className="text-right">整本《红楼梦》</th>
                  <th className="text-right">推理峰值内存</th>
                </tr>
              </thead>
              <tbody>
                {MODEL_BENCHMARKS.map((row) => (
                  <tr key={row.name} className="border-base-content/8">
                    <td className="font-medium whitespace-nowrap">
                      <span className="inline-flex items-center gap-2">
                        {row.name}
                        {row.recommended ? (
                          <span className="badge badge-primary badge-soft badge-sm">推荐</span>
                        ) : null}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{row.size}</td>
                    <td className="text-right font-medium tabular-nums">{row.throughput}</td>
                    <td className="text-right tabular-nums">{row.wholeBook}</td>
                    <td className="text-right tabular-nums">{row.peakMemory}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
