import { useEffect } from "react";
import { useSerifFont } from "../hooks/useSerifFont";
import { formatBytes } from "../lib/models";

interface Props {
  open: boolean;
  onBusyChange?: (busy: boolean) => void;
  onChange?: () => void;
}

/**
 * 设置 → 阅读字体：按需从魔搭下载 / 移除思源宋体（Source Han Serif SC）。
 */
export function FontSection({ open, onBusyChange, onChange }: Props) {
  const { status, op, progress, error, install, remove } = useSerifFont(open);
  const busy = op !== null;

  useEffect(() => {
    onBusyChange?.(busy);
    return () => {
      if (busy) onBusyChange?.(false);
    };
  }, [busy, onBusyChange]);

  const isDownloading = op === "install";
  const isRemoving = op === "remove";
  const totalBytes = progress?.total || status?.bytes || 0;
  const ratio =
    isDownloading && progress && totalBytes > 0 ? Math.min(1, progress.done / totalBytes) : 0;

  const handleInstall = async () => {
    const next = await install();
    if (next?.installed) onChange?.();
  };

  const handleRemove = async () => {
    const next = await remove();
    if (next && !next.installed) onChange?.();
  };

  return (
    <section aria-labelledby="fonts-title" className="mt-5 border-t border-base-content/10 pt-4">
      <h4 id="fonts-title" className="text-sm font-semibold">
        阅读字体
      </h4>
      <p className="mt-1 text-sm leading-relaxed text-base-content/65">
        思源宋体按需下载，仅在阅读页切换为思源宋体时使用，可随时移除以释放空间。
      </p>

      {error && (
        <div role="alert" className="alert alert-error mt-3 text-sm">
          <span className="break-words">{error}</span>
        </div>
      )}

      {status === null ? (
        <div className="mt-3">
          <div className="skeleton h-16 rounded-box" />
        </div>
      ) : (
        <div className="card mt-3 w-full border border-base-content/10 bg-base-100 text-left">
          <div className="card-body gap-2 p-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h5 className="text-sm font-semibold">思源宋体</h5>
                  {status.installed && (
                    <span className="badge badge-success badge-soft badge-xs">已下载</span>
                  )}
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-base-content/60">
                  Source Han Serif SC（Regular · OFL-1.1）
                </p>
                <p className="mt-1 text-xs text-base-content/50">
                  {formatBytes(status.installed ? status.size : status.bytes)}
                  {status.partial > 0 && !status.installed && (
                    <> · 已下载 {formatBytes(status.partial)}</>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {status.installed ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm text-error"
                    disabled={busy}
                    onClick={() => void handleRemove()}
                  >
                    {isRemoving ? (
                      <span className="loading loading-spinner loading-xs" />
                    ) : (
                      "移除字体"
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => void handleInstall()}
                  >
                    {isDownloading ? (
                      <span className="loading loading-spinner loading-xs" />
                    ) : status.partial > 0 ? (
                      "继续下载字体"
                    ) : (
                      "下载字体"
                    )}
                  </button>
                )}
              </div>
            </div>
            {isDownloading && (
              <>
                <progress
                  className="progress progress-primary w-full"
                  value={ratio}
                  max={1}
                  aria-label="正在下载思源宋体"
                />
                <p className="text-xs tabular-nums text-base-content/55">
                  {progress
                    ? `SourceHanSerifSC-Regular.woff2 · ${Math.round(ratio * 100)}%`
                    : "开始中…"}
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
