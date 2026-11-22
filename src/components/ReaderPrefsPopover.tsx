import { memo, useEffect, useState } from "react";
import {
  DEFAULT_SVO_COLORS,
  DEFAULT_SVO_OVERRIDES,
  hasCustomSvoColors,
  READER_PREFS_BOUNDS,
  type ReaderColumns,
  type ReaderFontFamily,
  type ReaderPageMargin,
  type ReaderPrefs,
  type ReaderTextAlign,
  type ReaderTheme,
  type ReaderViewMode,
  type SvoRole,
} from "../lib/readerPrefs";

interface Props {
  prefs: ReaderPrefs;
  effectiveTheme: ReaderTheme;
  onUpdate: (patch: Partial<ReaderPrefs>) => void;
}

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof window !== "undefined"
      ? Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches)
      : false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
    setDark(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return dark;
}

export const ReaderPrefsPopover = memo(function ReaderPrefsPopover({
  prefs,
  effectiveTheme,
  onUpdate,
}: Props) {
  const systemDark = useSystemDark();
  const resolvedPaper: "light" | "sepia" | "dark" =
    effectiveTheme === "sepia"
      ? "sepia"
      : effectiveTheme === "dark" || (effectiveTheme === "auto" && systemDark)
        ? "dark"
        : "light";

  return (
    <div className="dropdown-content card z-30 mt-2 max-h-[calc(100dvh-5rem)] w-72 overflow-y-auto bg-base-100 shadow-xl ring-1 ring-base-content/10">
      <div className="card-body gap-3 p-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-base-content/70">翻页方式</span>
          <div className="join">
            {(
              [
                ["scrolled", "滚动"],
                ["paginated", "分页"],
              ] as [ReaderViewMode, string][]
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={`btn btn-xs join-item ${prefs.viewMode === mode ? "btn-primary" : "btn-ghost"}`}
                onClick={() => onUpdate({ viewMode: mode })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {prefs.viewMode === "paginated" && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-base-content/70">栏数</span>
            <div className="join">
              {(
                [
                  ["auto", "自动"],
                  [1, "单栏"],
                  [2, "双栏"],
                ] as [ReaderColumns, string][]
              ).map(([cols, label]) => (
                <button
                  key={String(cols)}
                  type="button"
                  className={`btn btn-xs join-item ${prefs.columns === cols ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => onUpdate({ columns: cols })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-base-content/70">纸色</span>
          <div className="join">
            {(
              [
                ["auto", "自动"],
                ["light", "亮"],
                ["sepia", "纸"],
                ["dark", "暗"],
              ] as [ReaderTheme, string][]
            ).map(([theme, label]) => (
              <button
                key={theme}
                type="button"
                className={`btn btn-xs join-item ${prefs.theme === theme ? "btn-primary" : "btn-ghost"}`}
                onClick={() => onUpdate({ theme })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-base-content/70">字体</span>
          <div className="join">
            {(
              [
                ["default", "默认"],
                ["serif", "思源宋体"],
              ] as [ReaderFontFamily, string][]
            ).map(([fontFamily, label]) => (
              <button
                key={fontFamily}
                type="button"
                className={`btn btn-xs join-item ${prefs.fontFamily === fontFamily ? "btn-primary" : "btn-ghost"}`}
                onClick={() => onUpdate({ fontFamily })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-base-content/70">字号</span>
            <span className="text-xs tabular-nums text-base-content/60">{prefs.fontSize}px</span>
          </div>
          <input
            type="range"
            aria-label="字号"
            min={READER_PREFS_BOUNDS.fontSize.min}
            max={READER_PREFS_BOUNDS.fontSize.max}
            step={READER_PREFS_BOUNDS.fontSize.step}
            value={prefs.fontSize}
            onChange={(event) => onUpdate({ fontSize: Number(event.target.value) })}
            className="range range-xs range-primary"
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-base-content/70">行距</span>
            <span className="text-xs tabular-nums text-base-content/60">
              {prefs.lineHeight.toFixed(1)}
            </span>
          </div>
          <input
            type="range"
            aria-label="行距"
            min={READER_PREFS_BOUNDS.lineHeight.min}
            max={READER_PREFS_BOUNDS.lineHeight.max}
            step={READER_PREFS_BOUNDS.lineHeight.step}
            value={prefs.lineHeight}
            onChange={(event) => onUpdate({ lineHeight: Number(event.target.value) })}
            className="range range-xs range-primary"
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-base-content/70">段间距</span>
            <span className="text-xs tabular-nums text-base-content/60">
              {prefs.paragraphSpacing.toFixed(1)}em
            </span>
          </div>
          <input
            type="range"
            aria-label="段间距"
            min={READER_PREFS_BOUNDS.paragraphSpacing.min}
            max={READER_PREFS_BOUNDS.paragraphSpacing.max}
            step={0.2}
            value={prefs.paragraphSpacing}
            onChange={(event) => onUpdate({ paragraphSpacing: Number(event.target.value) })}
            className="range range-xs range-primary"
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-base-content/70">页边距</span>
          <div className="join">
            {(
              [
                ["compact", "窄"],
                ["normal", "适中"],
                ["wide", "宽"],
              ] as [ReaderPageMargin, string][]
            ).map(([pageMargin, label]) => (
              <button
                key={pageMargin}
                type="button"
                className={`btn btn-xs join-item ${prefs.pageMargin === pageMargin ? "btn-primary" : "btn-ghost"}`}
                onClick={() => onUpdate({ pageMargin })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-base-content/70">对齐</span>
          <div className="join">
            {(
              [
                ["default", "默认"],
                ["justify", "两端对齐"],
              ] as [ReaderTextAlign, string][]
            ).map(([textAlign, label]) => (
              <button
                key={textAlign}
                type="button"
                className={`btn btn-xs join-item ${prefs.textAlign === textAlign ? "btn-primary" : "btn-ghost"}`}
                onClick={() => onUpdate({ textAlign })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-base-content/70">翻页动画</span>
          <input
            type="checkbox"
            aria-label="翻页动画开关"
            className="toggle toggle-primary toggle-sm"
            checked={prefs.pageAnimation}
            onChange={(event) => onUpdate({ pageAnimation: event.target.checked })}
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-base-content/70">深色插图护眼</span>
          <input
            type="checkbox"
            aria-label="深色插图护眼开关"
            className="toggle toggle-primary toggle-sm"
            checked={prefs.dimImagesInDark}
            onChange={(event) => onUpdate({ dimImagesInDark: event.target.checked })}
          />
        </div>

        <div className="divider my-0" />

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-base-content/70">主谓宾着色</span>
          <input
            type="checkbox"
            aria-label="主谓宾着色开关"
            className="toggle toggle-primary toggle-sm"
            checked={prefs.coloringEnabled}
            onChange={(event) => onUpdate({ coloringEnabled: event.target.checked })}
          />
        </div>

        {prefs.coloringEnabled && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-base-content/70">颜色</span>
              {hasCustomSvoColors(prefs.svoColors) && (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs h-6 min-h-6 px-1.5 text-base-content/60"
                  onClick={() => onUpdate({ svoColors: DEFAULT_SVO_OVERRIDES })}
                >
                  恢复默认
                </button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  ["subject", "主语"],
                  ["predicate", "谓语"],
                  ["object", "宾语"],
                ] as [SvoRole, string][]
              ).map(([role, label]) => {
                const color = prefs.svoColors[role] ?? DEFAULT_SVO_COLORS[resolvedPaper][role];
                return (
                  <label
                    key={role}
                    className="btn btn-xs btn-ghost relative h-7 min-h-7 justify-center gap-1.5 border border-base-content/15 font-normal"
                  >
                    <span
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span>{label}</span>
                    <input
                      type="color"
                      aria-label={`${label}颜色`}
                      value={color}
                      onChange={(event) =>
                        onUpdate({
                          svoColors: {
                            ...prefs.svoColors,
                            [role]: event.target.value,
                          },
                        })
                      }
                      className="sr-only"
                    />
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
