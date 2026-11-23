import Laptop from 'lucide-react/icons/laptop';
import Monitor from 'lucide-react/icons/monitor';
import Smartphone from 'lucide-react/icons/smartphone';
import Terminal from 'lucide-react/icons/terminal';
import type { LucideIcon } from 'lucide-react';

export type Platform = 'android' | 'windows' | 'macos' | 'linux';

export const platformOrder: Platform[] = ['android', 'windows', 'macos', 'linux'];

export const platformMeta: Record<
  Platform,
  { label: string; hint: string; pkg: string; icon: LucideIcon }
> = {
  android: { label: 'Android', hint: 'Android 7.0+ · arm64-v8a', pkg: 'APK', icon: Smartphone },
  windows: { label: 'Windows', hint: 'Windows 10/11 · x64', pkg: 'EXE / MSI', icon: Monitor },
  macos: { label: 'macOS', hint: 'macOS 13.0+ · Apple Silicon', pkg: 'DMG', icon: Laptop },
  linux: { label: 'Linux', hint: 'x86_64', pkg: 'DEB / RPM', icon: Terminal },
};

// 演示文本出自鲁迅《故事新编·补天》。着色由仓库里的真实分析器生成
// （src-tauri/examples/svodemo.rs），不是手标的，升级模型后可用它重新生成。
export const DEMO_PARAGRAPHS: { text: string; colored: boolean }[] = [
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

export const MODEL_BENCHMARKS = [
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

export function Paragraph({
  html,
  colored,
  className,
}: {
  html: string;
  colored: boolean;
  className?: string;
}) {
  if (!colored) {
    return (
      <p className={className ?? 'text-[0.95rem] text-base-content/75 sm:text-base'}>
        {html}
      </p>
    );
  }
  return (
    <p
      className={className ?? 'text-[0.95rem] text-base-content/90 sm:text-base'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function SvoLegend({ size = 'sm' }: { size?: 'sm' | 'md' | 'lg' }) {
  const badgeSize = size === 'lg' ? 'badge-lg px-3.5 py-3 text-sm' : size === 'md' ? 'badge-md px-3 text-sm' : 'badge-sm';
  return (
    <div className="flex flex-wrap gap-1.5">
      <span className={`badge badge-outline ${badgeSize} border-base-content/15 bg-base-100/70`}>
        <span className="svo-subject font-medium">主语</span>
      </span>
      <span className={`badge badge-outline ${badgeSize} border-base-content/15 bg-base-100/70`}>
        <span className="svo-predicate font-medium">谓语</span>
      </span>
      <span className={`badge badge-outline ${badgeSize} border-base-content/15 bg-base-100/70`}>
        <span className="svo-object font-medium">宾语</span>
      </span>
    </div>
  );
}

export function BenchmarkTable({ tableClassName = 'table table-sm sm:table-md' }: { tableClassName?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={tableClassName}>
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
  );
}
