import { useCallback, useEffect, useState } from "react";
import {
  checkUpdate,
  compareVersions,
  downloadUpdate,
  formatSize,
  onUpdateProgress,
  openReleasePage,
  plainNotes,
  revealUpdate,
  type UpdateProgress,
  type UpdateStatus,
} from "../lib/update";
import { message } from "../lib/reading";

/** Update metadata survives remounts (shelf ⇄ reader): one check per app run. */
let cachedStatus: UpdateStatus | null = null;

/**
 * 设置 → 版本与更新：当前版本、检查更新、应用内下载。安装包来自 GitHub
 * Releases 并由 Rust 侧边下边校验 SHA-256；下载完成后在文件管理器中显示。
 * Android 没有安装交接（BioCN 还没有 MusicDan 那套 install_apk），只给
 * 发布页链接。
 */
export function UpdateSection({ open }: { open: boolean }) {
  const [status, setStatus] = useState<UpdateStatus | null>(cachedStatus);
  // `attempted` counts a failed check too: the open effect must not retry on
  // its own, or an unreachable Pages site would re-request in a tight loop.
  const [attempted, setAttempted] = useState(cachedStatus !== null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const check = useCallback(async () => {
    setAttempted(true);
    setChecking(true);
    setCheckError(null);
    try {
      const next = await checkUpdate();
      cachedStatus = next;
      setStatus(next);
    } catch (error) {
      setCheckError(message(error));
    } finally {
      setChecking(false);
    }
  }, []);

  // The first open of the settings dialog performs the check, so app startup
  // stays offline; a failed check can be retried from the button any time.
  useEffect(() => {
    if (open && !attempted) void check();
  }, [open, attempted, check]);

  const reveal = async (path: string) => {
    try {
      await revealUpdate(path);
    } catch (error) {
      setProblem(message(error));
    }
  };

  const latest = status?.latest ?? null;
  const asset = latest?.download ?? null;
  const hasUpdate =
    !!status && !!latest && compareVersions(status.currentVersion, latest.version) < 0;

  const download = async () => {
    if (!latest || !asset) return;
    if (!asset.sha256) {
      setProblem("该版本未提供 SHA-256 校验值，请到发布页手动下载");
      return;
    }
    setDownloading(true);
    setProblem(null);
    setDownloaded(null);
    // Everything from the subscription on is guarded: if listening fails,
    // `downloading` still clears, or the download button would stay disabled.
    let unlisten: (() => void) | undefined;
    try {
      // Subscribe before the command: a fast CDN response can finish before a
      // listener attached afterwards is told.
      unlisten = await onUpdateProgress((event) => setProgress(event));
      const file = await downloadUpdate(asset.url, asset.sha256);
      await revealUpdate(file.path);
      setDownloaded(file.path);
    } catch (error) {
      setProblem(message(error));
    } finally {
      unlisten?.();
      setDownloading(false);
      setProgress(null);
    }
  };

  // The bar is determinate only when the server announced a total size;
  // otherwise daisyUI renders it indeterminate.
  const ratio =
    downloading && progress !== null && progress.total > 0
      ? Math.min(1, progress.received / progress.total)
      : null;
  const notes = latest !== null ? plainNotes(latest.notes) : [];

  return (
    <section aria-labelledby="update-title" className="mt-5 border-t border-base-content/10 pt-4">
      <div className="flex items-center justify-between gap-3">
        <h4 id="update-title" className="text-sm font-semibold">
          版本与更新
        </h4>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={checking}
          onClick={() => void check()}
        >
          {checking && <span className="loading loading-spinner loading-xs" />}
          {checking ? "检查中…" : "检查更新"}
        </button>
      </div>
      <p className="mt-1 text-xs text-base-content/55">
        当前版本{status !== null ? ` v${status.currentVersion}` : "…"}
      </p>

      {checkError !== null && (
        <>
          <div role="alert" className="alert alert-error alert-soft mt-3 text-sm">
            <span className="min-w-0 break-words">检查更新失败：{checkError}</span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm mt-1"
            onClick={() => void openReleasePage()}
          >
            到发布页下载
          </button>
        </>
      )}

      {attempted && checkError === null && hasUpdate && latest !== null && (
        <div className="mt-3 rounded-box border border-base-content/10 bg-base-200/40 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold">发现新版本 v{latest.version}</p>
              <p className="mt-0.5 text-xs text-base-content/60">
                {asset !== null
                  ? `${asset.name} · ${formatSize(asset.size)}`
                  : "当前平台没有应用内下载"}
              </p>
            </div>
            {asset !== null ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={downloading}
                onClick={() => void download()}
              >
                {downloading && <span className="loading loading-spinner loading-xs" />}
                {downloading ? "下载中…" : "下载"}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void openReleasePage()}
              >
                到发布页下载
              </button>
            )}
          </div>

          {downloading && (
            <div className="mt-3">
              <progress
                className="progress progress-primary w-full"
                value={ratio ?? undefined}
                max={1}
                aria-label="正在下载并校验安装包"
              />
              <p className="mt-1 text-xs text-base-content/55">
                {ratio === null
                  ? "正在下载并校验安装包…"
                  : `正在下载并校验安装包 ${Math.round(ratio * 100)}%`}
              </p>
            </div>
          )}

          {downloaded !== null && (
            <p className="mt-2 text-xs text-base-content/55">
              安装包已下载并通过 SHA-256 校验，已在文件管理器中显示。
              <button
                type="button"
                className="btn btn-link btn-xs px-1 align-baseline"
                onClick={() => void reveal(downloaded)}
              >
                再次打开
              </button>
            </p>
          )}

          {problem !== null && (
            <div role="alert" className="alert alert-error alert-soft mt-3 text-sm">
              <span className="min-w-0 break-words">{problem}</span>
            </div>
          )}

          {notes.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-base-content/60">更新内容</summary>
              <ul className="mt-1 space-y-0.5 text-xs leading-relaxed text-base-content/65">
                {notes.map((line, index) => (
                  // The same line can occur twice, so index the key.
                  <li key={`${index}:${line}`}>{line}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {attempted && checkError === null && latest !== null && !hasUpdate && (
        <p className="mt-2 text-xs text-base-content/55">已是最新版本</p>
      )}

      {attempted && checkError === null && latest === null && (
        <p className="mt-2 text-xs text-base-content/55">暂时无法获取更新信息</p>
      )}
    </section>
  );
}
