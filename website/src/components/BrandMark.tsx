// 品牌字标（静态）：Bio = bionic reading（谓语绿），CN = Chinese（主语橙）。
// 名字由来的动画版本在 HeroTitle.tsx（hero 大标题处）；这里保持静态常驻。
export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`select-none inline-flex items-baseline font-bold leading-none tracking-tight ${className}`}
      aria-label="BioCN"
    >
      <span className="svo-predicate">Bio</span>
      <span className="svo-subject">CN</span>
    </span>
  );
}
