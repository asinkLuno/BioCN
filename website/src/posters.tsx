import { createRoot } from 'react-dom/client';
import { HelixMark } from './components/HeroTitle';
import {
  BenchmarkTable,
  DEMO_PARAGRAPHS,
  Paragraph,
  SvoLegend,
  platformMeta,
  platformOrder,
} from './showcase';
import './index.css';
import './posters.css';

const PLAIN_PARAGRAPHS = DEMO_PARAGRAPHS.filter((p) => !p.colored);
const COLORED_PARAGRAPHS = DEMO_PARAGRAPHS.filter((p) => p.colored);

function PosterCoverComparison() {
  return (
    <section className="poster-canvas flex flex-col justify-between px-11 py-10 text-base-content">
      {/* 上半部分：未开启仿生阅读 */}
      <div className="card border border-base-content/10 bg-base-200/75">
        <div className="card-body gap-2.5 p-4">
          <div className="flex items-center px-1">
            <span className="badge badge-ghost badge-md font-medium text-base-content/60">
              普通阅读
            </span>
          </div>
          <article className="heti heti--serif demo-heti poster-reading rounded-box border border-base-content/8 bg-base-100 px-5 py-4">
            {PLAIN_PARAGRAPHS.map((paragraph, index) => (
              <Paragraph
                key={index}
                html={paragraph.text}
                colored={false}
                className="text-[16.2px] leading-[1.7] text-base-content/72"
              />
            ))}
          </article>
        </div>
      </div>

      {/* 中间大标题：BioCN + 为 ADHD 设计的中文仿生阅读软件 */}
      <div className="flex flex-col items-center justify-center gap-3 py-1 text-center">
        <div className="flex items-center justify-center gap-4">
          <HelixMark className="size-16 shrink-0" />
          <h1 className="text-[64px] font-extrabold leading-none tracking-[-0.03em]">
            <span className="svo-predicate">Bio</span>
            <span className="svo-object">CN</span>
          </h1>
        </div>
        <p className="text-[26px] font-bold leading-snug tracking-tight text-base-content">
          为 ADHD 设计的中文仿生阅读软件
        </p>
      </div>

      {/* 下半部分：开启仿生阅读 */}
      <div className="card border border-primary/30 bg-primary/[0.06]">
        <div className="card-body gap-2.5 p-4">
          <div className="flex items-center justify-between px-1">
            <span className="badge badge-primary badge-soft badge-md font-semibold">
              BioCN 仿生阅读
            </span>
            <SvoLegend size="md" />
          </div>
          <article className="heti heti--serif demo-heti poster-reading rounded-box border border-primary/20 bg-base-100 px-5 py-4">
            {COLORED_PARAGRAPHS.map((paragraph, index) => (
              <Paragraph
                key={index}
                html={paragraph.text}
                colored
                className="text-[16.2px] leading-[1.7] text-base-content/90"
              />
            ))}
          </article>
        </div>
      </div>
    </section>
  );
}

function PosterWhyBioCN() {
  return (
    <section className="poster-canvas flex flex-col justify-between px-14 py-14 text-base-content">
      <div className="space-y-3.5">
        <h1 className="text-[48px] font-extrabold leading-[1.24] tracking-[-0.025em]">
          中文没有单词的边界，
          <br />
          所以需要自己的仿生阅读。
        </h1>
        <p className="text-[20px] leading-relaxed text-base-content/60">
          专为 ADHD 与容易分心的读者设计，借助 HanLP 句法分析标出句子主线。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-5">
        <div className="card border border-base-content/10 bg-base-100">
          <div className="card-body gap-4 p-6">
            <h2 className="text-lg font-bold">英文仿生阅读</h2>
            <div className="rounded-box bg-base-200 px-5 py-4 text-[19px] leading-relaxed text-base-content/65">
              <strong className="font-extrabold text-base-content">Bio</strong>nic{' '}
              <strong className="font-extrabold text-base-content">rea</strong>ding{' '}
              <strong className="font-extrabold text-base-content">gui</strong>des{' '}
              <strong className="font-extrabold text-base-content">th</strong>e{' '}
              <strong className="font-extrabold text-base-content">ey</strong>es{' '}
              <strong className="font-extrabold text-base-content">thro</strong>ugh{' '}
              <strong className="font-extrabold text-base-content">te</strong>xt{' '}
              <strong className="font-extrabold text-base-content">wi</strong>th{' '}
              <strong className="font-extrabold text-base-content">fixa</strong>tion{' '}
              <strong className="font-extrabold text-base-content">poi</strong>nts.
            </div>
            <p className="text-[16.5px] leading-relaxed text-base-content/75">
              依靠空格区分单词，加粗每个词的开头就能帮眼睛锚定重心。
            </p>
          </div>
        </div>

        <div className="card border border-base-content/10 bg-base-100">
          <div className="card-body gap-4 p-6">
            <h2 className="text-lg font-bold">照搬英文仿生阅读</h2>
            <div
              className="heti heti--serif rounded-box bg-base-200 px-5 py-4 text-[19px] leading-[1.82] text-base-content/62"
              style={{ fontFamily: 'var(--font-serif)' }}
            >
              <strong className="font-extrabold text-base-content">中</strong>文
              <strong className="font-extrabold text-base-content">没</strong>有
              <strong className="font-extrabold text-base-content">空</strong>格
              <strong className="font-extrabold text-base-content">边</strong>界，
              <strong className="font-extrabold text-base-content">直</strong>接
              <strong className="font-extrabold text-base-content">隔</strong>字
              <strong className="font-extrabold text-base-content">加</strong>粗
              <strong className="font-extrabold text-base-content">反</strong>而
              <strong className="font-extrabold text-base-content">打</strong>乱
              <strong className="font-extrabold text-base-content">语</strong>意。
            </div>
            <p className="text-[16.5px] leading-relaxed text-base-content/75">
              中文没有词间空格边界，直接加粗字首根本行不通。
            </p>
          </div>
        </div>
      </div>

      <div className="card border border-primary/30 bg-primary/[0.06]">
        <div className="card-body gap-6 p-7">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="badge badge-primary badge-soft badge-lg font-semibold">
                BioCN 句法染色
              </span>
              <h2 className="text-xl font-bold text-primary">长句主干一眼看清</h2>
            </div>
            <SvoLegend size="lg" />
          </div>

          <div className="space-y-6 rounded-box border border-primary/20 bg-base-100 px-9 py-10">
            <p
              className="heti heti--serif text-[29px] leading-[2.05] text-base-content/90"
              style={{ fontFamily: 'var(--font-serif)' }}
            >
              <span className="svo-subject inline-block rounded-field border-b-[3px] border-current bg-secondary/10 px-1 leading-[1.45] font-bold">
                地上
              </span>
              都
              <span className="svo-predicate inline-block rounded-field border-b-[3px] border-current bg-primary/10 px-1 leading-[1.45] font-bold">
                嫩绿
              </span>
              了，便是不很换叶的
              <span className="svo-subject inline-block rounded-field border-b-[3px] border-current bg-secondary/10 px-1 leading-[1.45] font-bold">
                松柏
              </span>
              也显得格外的
              <span className="svo-predicate inline-block rounded-field border-b-[3px] border-current bg-primary/10 px-1 leading-[1.45] font-bold">
                娇嫩
              </span>
              。
            </p>
            <p
              className="heti heti--serif text-[29px] leading-[2.05] text-base-content/90"
              style={{ fontFamily: 'var(--font-serif)' }}
            >
              桃红和青白色的斗大的
              <span className="svo-subject inline-block rounded-field border-b-[3px] border-current bg-secondary/10 px-1 leading-[1.45] font-bold">
                杂花
              </span>
              ，在眼前还
              <span className="svo-predicate inline-block rounded-field border-b-[3px] border-current bg-primary/10 px-1 leading-[1.45] font-bold">
                分明
              </span>
              ，到远处可就
              <span className="svo-predicate inline-block rounded-field border-b-[3px] border-current bg-primary/10 px-1 leading-[1.45] font-bold">
                成为
              </span>
              斑斓的
              <span className="svo-object inline-block rounded-field border-b-[3px] border-current bg-accent/10 px-1 leading-[1.45] font-bold">
                烟霭
              </span>
              了。
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function PosterBenchmarkDownload() {
  return (
    <section className="poster-canvas flex flex-col justify-between px-14 py-14 text-base-content">
      <div className="space-y-3.5">
        <h1 className="text-[48px] font-extrabold leading-[1.24] tracking-[-0.025em]">
          整本 107 万字《红楼梦》，
          <br />
          本地离线不到 2 分钟。
        </h1>
        <p className="text-[20px] leading-relaxed text-base-content/60">
          全流程本地 CPU 运行，不依赖显卡与云端，结果缓存二次秒开。
        </p>
      </div>

      <div className="stats w-full border border-base-content/10 bg-base-100">
        <div className="stat gap-1.5 bg-primary/[0.05] px-6 py-6">
          <div className="stat-value text-[38px] font-extrabold tracking-tight text-primary tabular-nums">
            1 分 59 秒
          </div>
          <div className="stat-title text-base font-bold text-base-content/75">
            整本《红楼梦》耗时
          </div>
        </div>
        <div className="stat gap-1.5 px-6 py-6">
          <div className="stat-value svo-subject text-[38px] font-extrabold tracking-tight tabular-nums">
            361 句/秒
          </div>
          <div className="stat-title text-base font-bold text-base-content/75">
            省流 INT8 分析吞吐
          </div>
        </div>
        <div className="stat gap-1.5 px-6 py-6">
          <div className="stat-value svo-object text-[38px] font-extrabold tracking-tight tabular-nums">
            64.3 MB
          </div>
          <div className="stat-title text-base font-bold text-base-content/75">
            轻量模型体积
          </div>
        </div>
      </div>

      <div className="card border border-base-content/10 bg-base-200/75">
        <div className="card-body p-5">
          <div className="rounded-box border border-base-content/8 bg-base-100 px-2 py-1">
            <BenchmarkTable tableClassName="table table-lg text-[16.5px]" />
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[22px] font-extrabold tracking-tight">四大平台原生安装</h2>
          <span className="badge badge-primary badge-soft badge-lg font-semibold">
            GPL-3.0 开源免费
          </span>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {platformOrder.map((platform) => {
            const meta = platformMeta[platform];
            const Icon = meta.icon;
            return (
              <div key={platform} className="card border border-base-content/10 bg-base-100">
                <div className="card-body flex-row items-center justify-between p-5">
                  <div className="flex items-center gap-3.5">
                    <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon aria-hidden="true" className="size-5" />
                    </div>
                    <span className="text-xl font-bold">{meta.label}</span>
                  </div>
                  <span className="badge badge-ghost badge-md font-mono font-semibold text-base-content/65">
                    {meta.pkg}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div
        data-theme="dark"
        className="card bg-base-100 text-base-content shadow-none"
      >
        <div className="card-body flex-row items-center justify-between px-7 py-6">
          <div className="flex items-center gap-4">
            <HelixMark className="size-11 shrink-0" />
            <span className="text-2xl font-extrabold tracking-tight">BioCN · 立即下载</span>
          </div>
          <span className="font-mono text-base font-semibold text-primary">
            asinkluno.github.io/BioCN
          </span>
        </div>
      </div>
    </section>
  );
}

const POSTERS = [
  { id: '1', label: '01 · 上下全文对比封面', element: <PosterCoverComparison /> },
  { id: '2', label: '02 · 为什么做中文仿生阅读', element: <PosterWhyBioCN /> },
  { id: '3', label: '03 · 性能实测与全平台下载', element: <PosterBenchmarkDownload /> },
] as const;

function PostersApp() {
  const params = new URLSearchParams(window.location.search);
  const singleId = params.get('poster');

  if (singleId) {
    document.body.className = 'h-[1200px] w-[900px] overflow-hidden bg-transparent';
    const found = POSTERS.find((p) => p.id === singleId) ?? POSTERS[0];
    return found.element;
  }

  document.body.className = 'min-h-screen bg-base-300';
  return (
    <div className="mx-auto max-w-[1440px] space-y-8 px-8 py-10">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight">BioCN · 3:4 展示海报（仅开发期）</h1>
        <p className="text-sm text-base-content/60">
          使用 <code>yarn posters:render</code> 导出 1800×2400 PNG 到 <code>design/posters/</code>
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-9">
        {POSTERS.map((poster) => (
          <div key={poster.id} className="space-y-2.5">
            <div className="flex items-center justify-between px-1 text-sm font-medium text-base-content/70">
              <span>{poster.label}</span>
              <a className="link link-primary text-xs" href={`?poster=${poster.id}`}>
                单张视图
              </a>
            </div>
            <div className="overflow-hidden rounded-2xl shadow-xl">{poster.element}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<PostersApp />);
