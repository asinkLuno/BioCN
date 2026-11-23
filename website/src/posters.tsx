import { createRoot } from 'react-dom/client';
import Download from 'lucide-react/icons/download';
import { HelixMark } from './components/HeroTitle';
import {
  DEMO_PARAGRAPHS,
  Paragraph,
  platformMeta,
  platformOrder,
} from './showcase';
import './index.css';
import './posters.css';

const PLAIN_PARAGRAPHS = DEMO_PARAGRAPHS.filter((p) => !p.colored);
const COLORED_PARAGRAPHS = DEMO_PARAGRAPHS.filter((p) => p.colored);

function PosterSvoLegend() {
  return (
    <div className="flex items-center gap-2">
      <span className="badge badge-md gap-1.5 border border-secondary/30 bg-secondary/10 px-3 font-semibold text-secondary">
        <span className="size-2 rounded-full bg-secondary" aria-hidden="true" />
        主语
      </span>
      <span className="badge badge-md gap-1.5 border border-primary/30 bg-primary/10 px-3 font-semibold text-primary">
        <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
        谓语
      </span>
      <span className="badge badge-md gap-1.5 border border-accent/30 bg-accent/10 px-3 font-semibold text-accent">
        <span className="size-2 rounded-full bg-accent" aria-hidden="true" />
        宾语
      </span>
    </div>
  );
}

function PosterCoverComparison() {
  return (
    <section className="poster-canvas flex flex-col justify-between px-10 py-9 text-base-content">
      {/* 上半部分：未开启仿生阅读（退后、低反差，体现普通长文阅读的平淡吃力） */}
      <div className="card border border-base-content/12 bg-base-200/85">
        <div className="card-body gap-3 px-6 py-5">
          <div className="flex items-center justify-between border-b border-base-content/10 pb-2.5">
            <span className="badge badge-ghost badge-md border-base-content/12 bg-base-100/70 px-3 font-semibold text-base-content/65">
              普通阅读
            </span>
          </div>
          <article className="heti heti--serif demo-heti poster-reading">
            {PLAIN_PARAGRAPHS.map((paragraph, index) => (
              <Paragraph
                key={index}
                html={paragraph.text}
                colored={false}
                className="text-[16.2px] leading-[1.68] text-base-content/60"
              />
            ))}
          </article>
        </div>
      </div>

      {/* 中间核心主标题：最大字号、最强反差的品牌与定位锚点 */}
      <div className="flex flex-col items-center justify-center gap-3.5 py-2 text-center">
        <div className="flex items-center justify-center gap-4.5">
          <HelixMark className="size-[82px] shrink-0" />
          <h1 className="text-[86px] font-black leading-none tracking-[-0.035em]">
            <span className="svo-predicate">Bio</span>
            <span className="svo-object">CN</span>
          </h1>
        </div>
        <p className="poster-display text-[34px] font-black leading-tight tracking-[-0.015em] text-base-content">
          为 <span className="svo-subject">ADHD</span> 设计的中文仿生阅读软件
        </p>
      </div>

      {/* 下半部分：开启仿生阅读（高亮、抬升、主谓宾骨架一眼跃出） */}
      <div className="poster-hero-card card overflow-hidden bg-base-100">
        <div className="flex items-center justify-between border-b border-primary/15 bg-primary/[0.08] px-6 py-3">
          <span className="badge badge-primary badge-lg px-3.5 text-[15px] font-bold tracking-wide">
            BioCN 仿生阅读
          </span>
          <PosterSvoLegend />
        </div>
        <div className="card-body px-6 py-4.5">
          <article className="heti heti--serif demo-heti poster-reading">
            {COLORED_PARAGRAPHS.map((paragraph, index) => (
              <Paragraph
                key={index}
                html={paragraph.text}
                colored
                className="text-[16.2px] leading-[1.68] text-base-content/68"
              />
            ))}
          </article>
        </div>
      </div>
    </section>
  );
}

function PosterWhyAndBenchmark() {
  return (
    <section className="poster-canvas flex flex-col justify-between px-12 py-11 text-base-content">
      {/* 一级核心论点：全张海报最大的视觉重心 */}
      <section className="space-y-5">
        <h2 className="poster-display text-[48px] font-black leading-[1.14] tracking-[-0.025em] text-base-content">
          为什么需要<span className="text-primary">中文仿生阅读</span>
        </h2>

        <div className="grid grid-cols-3 gap-4">
          <div className="card border border-base-content/10 bg-base-100/65">
            <div className="card-body justify-between gap-4 p-5">
              <div className="space-y-3">
                <span className="badge badge-ghost badge-sm border-base-content/12 bg-base-200/80 font-semibold text-base-content/65">
                  英文
                </span>
                <p className="text-[18.5px] leading-[1.72] text-base-content/65">
                  <strong className="font-extrabold text-base-content">Bio</strong>nic{' '}
                  <strong className="font-extrabold text-base-content">rea</strong>ding{' '}
                  <strong className="font-extrabold text-base-content">gui</strong>des{' '}
                  <strong className="font-extrabold text-base-content">th</strong>e{' '}
                  <strong className="font-extrabold text-base-content">ey</strong>es
                </p>
              </div>
              <p className="border-t border-base-content/8 pt-3 text-[15.5px] font-medium leading-snug text-base-content/60">
                加粗词首，给眼睛锚点
              </p>
            </div>
          </div>

          <div className="card border border-base-content/10 bg-base-100/65">
            <div className="card-body justify-between gap-4 p-5">
              <div className="space-y-3">
                <span className="badge badge-ghost badge-sm border-base-content/12 bg-base-200/80 font-semibold text-base-content/65">
                  中文
                </span>
                <p
                  className="heti heti--serif text-[18.2px] leading-[1.74] text-base-content/62"
                  style={{ fontFamily: 'var(--font-serif)' }}
                >
                  <strong className="font-black text-base-content">中</strong>文
                  <strong className="font-black text-base-content">没</strong>有
                  <strong className="font-black text-base-content">空</strong>格
                  <strong className="font-black text-base-content">边</strong>界，
                  <strong className="font-black text-base-content">直</strong>接
                  <strong className="font-black text-base-content">按</strong>词
                  <strong className="font-black text-base-content">加</strong>粗
                  <strong className="font-black text-base-content">反</strong>而
                  <strong className="font-black text-base-content">打</strong>断
                  <strong className="font-black text-base-content">语</strong>义。
                </p>
              </div>
              <p className="border-t border-base-content/8 pt-3 text-[15.5px] font-medium leading-snug text-secondary/85">
                照搬加粗，反而打断语义
              </p>
            </div>
          </div>

          {/* 第三栏作为答案主角：纯阴影抬升 + 浅青玉眉条呼应封面主卡，避免边线与阴影叠加 */}
          <div className="poster-hero-card card overflow-hidden bg-base-100">
            <div className="border-b border-primary/15 bg-primary/[0.08] px-5 py-2.5">
              <span className="badge badge-primary badge-sm px-2.5 font-bold">BioCN</span>
            </div>
            <div className="card-body justify-between gap-4 px-5 pt-4 pb-5">
              <p
                className="heti heti--serif demo-heti poster-reading text-[18.2px] leading-[1.74] text-base-content/68"
                style={{ fontFamily: 'var(--font-serif)' }}
              >
                <span className="svo-subject">中文</span>
                <span className="svo-predicate">没有</span>空格
                <span className="svo-object">边界</span>，直接按词
                <span className="svo-predicate">加粗</span>反而
                <span className="svo-predicate">打断</span>
                <span className="svo-object">语义</span>。
              </p>
              <p className="border-t border-primary/15 pt-3 text-[15.5px] font-bold leading-snug text-primary">
                主谓宾染色，主干一眼看清
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 二级硬核实测：次级标题 + 重点提亮正文 + 主次分明的数据矩阵 */}
      <section className="space-y-4">
        <div className="space-y-2.5">
          <h2 className="poster-display text-[34px] font-extrabold leading-tight tracking-[-0.02em] text-base-content">
            内置 EPUB 阅读器，边读边染色
          </h2>
          <p className="poster-prose-lead text-[19px] leading-[1.68] text-base-content/70">
            整本 <strong className="font-bold text-base-content">107 万字《红楼梦》</strong>全量染色仅需{' '}
            <strong className="font-bold text-primary">2 分钟</strong>：采用 INT8 量化模型，
            <strong className="font-semibold text-base-content">全流程本地 CPU 运行</strong>，不依赖显卡与云端，结果缓存二次秒开。
          </p>
        </div>

        <div className="card overflow-hidden border border-base-content/10 bg-base-100">
          <div className="grid grid-cols-[1.26fr_1.06fr_1fr_0.88fr] divide-x divide-base-content/10">
            <div className="flex flex-col justify-between gap-2 bg-primary/[0.07] px-5 py-5">
              <div className="text-[14.5px] font-semibold text-primary">整本《红楼梦》耗时</div>
              <div className="text-[40px] font-black leading-none tracking-[-0.03em] text-primary tabular-nums">
                1<span className="mx-0.5 text-[21px] font-bold">分</span>59
                <span className="ml-0.5 text-[21px] font-bold">秒</span>
              </div>
            </div>
            <div className="flex flex-col justify-between gap-2 px-5 py-5">
              <div className="text-[14.5px] font-medium text-base-content/60">省流 INT8 分析吞吐</div>
              <div className="text-[36px] font-extrabold leading-none tracking-[-0.025em] text-base-content tabular-nums">
                361<span className="ml-1 text-[18px] font-semibold text-base-content/65">句/秒</span>
              </div>
            </div>
            <div className="flex flex-col justify-between gap-2 px-5 py-5">
              <div className="text-[14.5px] font-medium text-base-content/60">INT8 推理峰值内存</div>
              <div className="text-[36px] font-extrabold leading-none tracking-[-0.025em] text-base-content tabular-nums">
                <span className="mr-0.5 text-[19px] font-semibold text-base-content/65">约</span>200
                <span className="ml-1 text-[18px] font-semibold text-base-content/65">MB</span>
              </div>
            </div>
            <div className="flex flex-col justify-between gap-2 px-5 py-5">
              <div className="text-[14.5px] font-medium text-base-content/60">模型权重体积</div>
              <div className="text-[36px] font-extrabold leading-none tracking-[-0.025em] text-base-content tabular-nums">
                64.3<span className="ml-1 text-[18px] font-semibold text-base-content/65">MB</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 三级辅助信息：收小标题层级，避免与核心论点抢焦 */}
      <section className="space-y-3.5">
        <h2 className="poster-display text-[26px] font-bold leading-tight tracking-[-0.015em] text-base-content/88">
          全平台支持
        </h2>
        <div className="grid grid-cols-4 gap-3.5">
          {platformOrder.map((platform) => {
            const meta = platformMeta[platform];
            const Icon = meta.icon;
            return (
              <div key={platform} className="card border border-base-content/10 bg-base-100/90">
                <div className="card-body items-start gap-2.5 p-4.5">
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon aria-hidden="true" className="size-5" />
                    </span>
                    <span className="text-[20px] font-bold tracking-tight text-base-content">
                      {meta.label}
                    </span>
                  </div>
                  <span className="poster-mono text-[14.5px] font-semibold tracking-tight text-base-content/58">
                    {meta.pkg}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 底部高反差主锚点：深青玉通栏收底，品牌网址 + 高对比度点击下载按钮 */}
      <div className="poster-cta-banner card text-primary-content">
        <div className="card-body flex-row items-center justify-between gap-5 px-7 py-6">
          <div className="flex items-center gap-4">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-base-100 p-1.5">
              <HelixMark className="size-11" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2.5">
                <span className="text-[28px] font-black leading-none tracking-[-0.025em] text-primary-content">
                  BioCN
                </span>
                <span className="badge badge-sm border-primary-content/30 bg-primary-content/15 font-semibold text-primary-content">
                  GPL-3.0
                </span>
              </div>
              <div className="poster-mono text-[17.5px] font-semibold tracking-tight text-primary-content/88">
                asinkluno.github.io/BioCN
              </div>
            </div>
          </div>
          <div className="btn btn-lg pointer-events-none h-auto min-h-0 gap-2.5 rounded-xl border-0 bg-base-100 px-6 py-3.5 text-[21px] font-black tracking-wide text-primary shadow-none">
            <Download aria-hidden="true" className="size-5.5 stroke-[2.5]" />
            <span>点击下载</span>
          </div>
        </div>
      </div>
    </section>
  );
}

const POSTERS = [
  { id: '1', label: '01 · 上下全文对比封面', element: <PosterCoverComparison /> },
  { id: '2', label: '02 · 为什么做 + 性能实测与全平台下载', element: <PosterWhyAndBenchmark /> },
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
