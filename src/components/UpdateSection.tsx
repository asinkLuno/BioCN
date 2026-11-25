import { useCallback, useEffect, useState } from "react";
import { isCancelledError } from "../lib/models";
import { message } from "../lib/reading";
import {
  cancelUpdateDownload,
  checkUpdate,
  compareVersions,
  downloadUpdate,
  formatSize,
  installApk,
  installPermission,
  onUpdateProgress,
  openInstallPermissionSettings,
  openReleasePage,
  parseReleaseNotes,
  revealUpdate,
  type ReleaseNoteBlock,
  type UpdateProgress,
  type UpdateStatus,
} from "../lib/update";

/** Update metadata survives remounts (shelf ⇄ reader): one check per app run. */
let cachedStatus: UpdateStatus | null = null;

/** Resets cached update metadata between unit tests. */
export function resetUpdateCacheForTests(): void {
  cachedStatus = null;
}

type UpdateBusy = "download" | "install" | null;

interface DownloadedAsset {
  version: string;
  path: string;
}

/**
 * 设置 → 版本与更新：当前版本、检查更新、应用内下载。安装包来自 GitHub
 * Releases 并由 Rust 侧边下边校验 SHA-256：
 * - 桌面端：下载校验完成后在文件管理器中显示安装包；
 * - Android：校验「安装未知应用」权限后下载 APK 并直接拉起系统安装器。
 */
export function UpdateSection({
  open,
  onBusyChange,
}: {
  open: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [status, setStatus] = useState<UpdateStatus | null>(cachedStatus);
  // `attempted` counts a failed check too: the open effect must not retry on
  // its own, or an unreachable Pages site would re-request in a tight loop.
  const [attempted, setAttempted] = useState(cachedStatus !== null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [busy, setBusy] = useState<UpdateBusy>(null);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [downloaded, setDownloaded] = useState<DownloadedAsset | null>(null);
  const [installerOpened, setInstallerOpened] = useState(false);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const isBusy = busy !== null;

  useEffect(() => {
    onBusyChange?.(isBusy);
    return () => {
      if (isBusy) onBusyChange?.(false);
    };
  }, [isBusy, onBusyChange]);

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
    setProblem(null);
    try {
      await revealUpdate(path);
    } catch (error) {
      setProblem(message(error));
    }
  };

  const openReleases = async () => {
    setProblem(null);
    try {
      await openReleasePage();
    } catch (error) {
      setProblem(message(error));
    }
  };

  const openPermissionSettings = async () => {
    setProblem(null);
    try {
      await openInstallPermissionSettings();
    } catch (error) {
      setProblem(message(error));
    }
  };

  const latest = status?.latest ?? null;
  const asset = latest?.download ?? null;
  const isAndroidApk = asset?.platform === "android";
  const hasUpdate =
    !!status && !!latest && compareVersions(status.currentVersion, latest.version) < 0;
  const downloadedPath =
    downloaded !== null && latest !== null && downloaded.version === latest.version
      ? downloaded.path
      : null;

  const ensureAndroidInstallPermission = async (): Promise<boolean> => {
    const permission = await installPermission();
    if (!permission.supported) {
      setProblem("当前平台不支持应用内安装");
      return false;
    }
    if (!permission.granted) {
      setNeedsPermission(true);
      try {
        await openInstallPermissionSettings();
      } catch (error) {
        setProblem(message(error));
        return false;
      }
      setProblem("请在系统设置中允许 BioCN 安装应用，然后返回重试");
      return false;
    }
    setNeedsPermission(false);
    return true;
  };

  const reinstallAndroid = async (path: string) => {
    setProblem(null);
    setInstallerOpened(false);
    try {
      if (!(await ensureAndroidInstallPermission())) return;
      setBusy("install");
      await installApk(path);
      setInstallerOpened(true);
    } catch (error) {
      setProblem(message(error));
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    if (!latest || !asset) return;
    if (isAndroidApk && downloadedPath !== null) {
      await reinstallAndroid(downloadedPath);
      return;
    }
    if (!asset.sha256) {
      setProblem("该版本未提供 SHA-256 校验值，请到发布页手动下载");
      return;
    }
    setProblem(null);
    setInstallerOpened(false);
    // Everything from the permission check / subscription on is guarded so
    // `busy` always clears and never leaves the button stuck disabled.
    let unlisten: (() => void) | undefined;
    try {
      if (isAndroidApk && !(await ensureAndroidInstallPermission())) {
        return;
      }
      setBusy("download");
      setCancelling(false);
      setDownloaded(null);
      // Subscribe before the command: a fast CDN response (or cached verified
      // installer) can finish before a listener attached afterwards is told.
      unlisten = await onUpdateProgress((event) => setProgress(event));
      const file = await downloadUpdate(asset.url, asset.sha256);
      // Persist the verified download path BEFORE opening the file manager or
      // Android package installer so a handoff failure still allows retrying.
      setDownloaded({ version: latest.version, path: file.path });
      if (isAndroidApk) {
        setBusy("install");
        await installApk(file.path);
        setInstallerOpened(true);
      } else {
        await revealUpdate(file.path);
      }
    } catch (error) {
      if (!isCancelledError(error)) {
        setProblem(message(error));
      }
    } finally {
      unlisten?.();
      setBusy(null);
      setCancelling(false);
      setProgress(null);
    }
  };

  const cancelDownload = async () => {
    setCancelling(true);
    await cancelUpdateDownload().catch(() => false);
  };

  // The bar is determinate only when the server announced a total size;
  // otherwise daisyUI renders it indeterminate.
  const ratio =
    busy === "download" && progress !== null && progress.total > 0
      ? Math.min(1, progress.received / progress.total)
      : null;
  const noteBlocks = latest !== null ? parseReleaseNotes(latest.notes) : [];
  const hasStructuredNotes = noteBlocks.some((block) => block.kind !== "changelog");
  const visibleNoteBlocks = hasStructuredNotes
    ? noteBlocks.filter((block) => block.kind !== "changelog")
    : noteBlocks;

  return (
    <section aria-labelledby="update-title" className="mt-5 border-t border-base-content/10 pt-4">
      <div className="flex items-center justify-between gap-3">
        <h4 id="update-title" className="text-sm font-semibold">
          版本与更新
        </h4>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={checking || isBusy}
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
            <span className="min-w-0 wrap-anywhere">检查更新失败：{checkError}</span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm mt-1"
            onClick={() => void openReleases()}
          >
            到发布页下载
          </button>
          {problem !== null && (
            <div role="alert" className="alert alert-error alert-soft mt-2 text-sm">
              <span className="min-w-0 wrap-anywhere">{problem}</span>
            </div>
          )}
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
              busy === "download" ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label="取消下载安装包"
                  disabled={cancelling}
                  onClick={() => void cancelDownload()}
                >
                  {cancelling ? (
                    <span className="loading loading-spinner loading-xs" />
                  ) : (
                    "取消"
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={isBusy}
                  onClick={() => void download()}
                >
                  {busy === "install" && <span className="loading loading-spinner loading-xs" />}
                  {busy === "install"
                    ? "安装中…"
                    : isAndroidApk
                      ? downloadedPath !== null
                        ? "再次安装"
                        : "下载并安装"
                      : "下载"}
                </button>
              )
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => void openReleases()}>
                到发布页下载
              </button>
            )}
          </div>

          {busy === "download" && (
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

          {isAndroidApk && installerOpened && (
            <p className="mt-2 text-xs text-base-content/55">
              安装包已通过 SHA-256 校验，请在系统安装器中确认安装。
            </p>
          )}

          {!isAndroidApk && downloadedPath !== null && (
            <p className="mt-2 text-xs text-base-content/55">
              安装包已下载并通过 SHA-256 校验，已在文件管理器中显示。
              <button
                type="button"
                className="btn btn-link btn-xs px-1 align-baseline"
                onClick={() => void reveal(downloadedPath)}
              >
                再次打开
              </button>
            </p>
          )}

          {needsPermission && (
            <button
              type="button"
              className="btn btn-ghost btn-sm mt-2"
              onClick={() => void openPermissionSettings()}
            >
              打开安装授权设置
            </button>
          )}

          {problem !== null && (
            <div role="alert" className="alert alert-error alert-soft mt-3 text-sm">
              <span className="min-w-0 wrap-anywhere">{problem}</span>
            </div>
          )}

          {visibleNoteBlocks.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-base-content/60">更新内容</summary>
              <div className="mt-1.5 space-y-1.5">
                {keyedBlocks(visibleNoteBlocks).map(({ key, block }) => {
                  if (block.kind === "heading") {
                    return (
                      <p key={key} className="pt-1 first:pt-0 text-xs font-semibold text-base-content/80">
                        {block.text}
                      </p>
                    );
                  }
                  if (block.kind === "list") {
                    return (
                      <ul
                        key={key}
                        className="list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-base-content/65"
                      >
                        {keyedLines(block.items).map(({ key: itemKey, text }) => (
                          <li key={itemKey}>{text}</li>
                        ))}
                      </ul>
                    );
                  }
                  if (block.kind === "changelog") {
                    return (
                      <button
                        key={key}
                        type="button"
                        className="btn btn-link btn-xs h-auto min-h-0 px-0 text-xs font-normal"
                        onClick={() => void openReleases()}
                      >
                        前往发布页查看完整变更
                      </button>
                    );
                  }
                  return (
                    <p key={key} className="text-xs leading-relaxed text-base-content/65">
                      {block.text}
                    </p>
                  );
                })}
              </div>
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

function keyedBlocks(
  blocks: readonly ReleaseNoteBlock[],
): { key: string; block: ReleaseNoteBlock }[] {
  const counts = new Map<string, number>();
  return blocks.map((block) => {
    const base =
      block.kind === "list"
        ? `list:${block.items.join("|")}`
        : block.kind === "changelog"
          ? `changelog:${block.url}`
          : `${block.kind}:${block.text}`;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return { key: count === 0 ? base : `${base}#${count}`, block };
  });
}

function keyedLines(lines: readonly string[]): { key: string; text: string }[] {
  // The same line can occur twice, so disambiguate duplicates by occurrence.
  const counts = new Map<string, number>();
  return lines.map((text) => {
    const count = counts.get(text) ?? 0;
    counts.set(text, count + 1);
    return { key: count === 0 ? text : `${text}#${count}`, text };
  });
}
