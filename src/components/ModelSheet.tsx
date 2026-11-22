import { useEffect, useRef, useState } from "react";
import { type AppTheme, applyAppTheme, loadAppTheme, saveAppTheme } from "../lib/appTheme";
import {
  formatBytes,
  type ModelProgress,
  type ModelStatus,
  modelsActivate,
  modelsInstall,
  modelsRemove,
  modelsStatus,
  onModelProgress,
  type VariantId,
} from "../lib/models";
import { message } from "../lib/reading";
import { useHistoryOverlay } from "../lib/router";
import { ModalBackdrop, useDialog } from "./dialog";
import { UpdateSection } from "./UpdateSection";

const THEME_OPTIONS: readonly [AppTheme, string][] = [
  ["auto", "跟随系统"],
  ["light", "浅色"],
  ["dark", "深色"],
];

/** A hoisted no-op: literal props in callers would be a fresh function every render. */
const noop = () => {};

interface Props {
  open: boolean;
  onClose: () => void;
  /** Told after any change on disk, so the reader re-checks the model. Defaults to a hoisted no-op. */
  onChange?: () => void;
}

/**
 * The model manager: what is on disk, what the reader loads, what a download
 * costs and how far it has got.
 *
 * Both variants can be installed side by side; `active` is the one the reader
 * loads. Progress is per file, but the user only cares about the variant, so
 * the bar is the sum over the variant's files: `done` of the current file plus
 * every byte already finished. The Rust side emits one event per chunk.
 */
type Operation =
  | { kind: "install"; variant: VariantId; progress: ModelProgress | null }
  | { kind: "activate"; variant: VariantId }
  | { kind: "remove"; variant: VariantId };

export function ModelSheet({ open, onClose, onChange = noop }: Props) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [op, setOp] = useState<Operation | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(() => loadAppTheme());
  const dialog = useRef<HTMLDialogElement>(null);

  const isBusy = op !== null || updateBusy;

  useHistoryOverlay(open, onClose, !isBusy);

  const selectTheme = (next: AppTheme) => {
    setTheme(next);
    saveAppTheme(next);
    applyAppTheme(next);
  };

  // Toggled open and closed by `open`: the app keeps a single sheet mounted.
  useDialog(dialog, open);

  // Read the status whenever the sheet opens: another window (or a crashed
  // download) may have changed what is on disk.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    modelsStatus()
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
          setProblem(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(message(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const install = async (variant: VariantId) => {
    setOp({ kind: "install", variant, progress: null });
    setProblem(null);
    // Everything from the subscription on is guarded: if listening fails,
    // `op` still clears, or every button in the sheet would stay disabled.
    let unlisten: (() => void) | undefined;
    try {
      // Subscribe before the command: a debug build copies from disk and can
      // finish every file before a listener attached afterwards is told.
      unlisten = await onModelProgress((event) =>
        setOp((prev) =>
          prev?.kind === "install" && prev.variant === variant
            ? { ...prev, progress: event }
            : prev,
        ),
      );
      setStatus(await modelsInstall(variant));
      onChange();
    } catch (error) {
      setProblem(message(error));
      // A failed download keeps its partial file; re-reading the status puts
      // the resume size on screen without wiping previous status on error.
      const refreshed = await modelsStatus().catch(() => null);
      if (refreshed !== null) setStatus(refreshed);
    } finally {
      unlisten?.();
      setOp(null);
    }
  };

  const activate = async (variant: VariantId) => {
    setOp({ kind: "activate", variant });
    setProblem(null);
    try {
      setStatus(await modelsActivate(variant));
      onChange();
    } catch (error) {
      setProblem(message(error));
    } finally {
      setOp(null);
    }
  };

  const remove = async (variant: VariantId) => {
    setOp({ kind: "remove", variant });
    setProblem(null);
    try {
      setStatus(await modelsRemove(variant));
      onChange();
    } catch (error) {
      setProblem(message(error));
    } finally {
      setOp(null);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby="settings-title"
      onClose={onClose}
      // Escape must not dismiss the sheet mid-download: the transfer keeps
      // running with nothing on screen to show it or to cancel it.
      onCancel={(event) => {
        if (isBusy) event.preventDefault();
        else onClose();
      }}
    >
      <div className="modal-box max-w-lg">
        <h3 id="settings-title" className="text-base font-semibold">
          设置
        </h3>

        <section
          aria-labelledby="appearance-title"
          className="mt-4 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="min-w-0">
            <h4 id="appearance-title" className="text-sm font-semibold">
              外观
            </h4>
            <p className="mt-0.5 text-xs text-base-content/60">
              应用界面主题（阅读器纸色可在阅读页单独调整）
            </p>
          </div>
          <fieldset
            aria-label="外观模式"
            className="join rounded-field border border-base-content/10 bg-base-200/70 p-0.5"
          >
            {THEME_OPTIONS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={theme === value}
                className={`btn btn-xs join-item border-0 ${
                  theme === value
                    ? "btn-primary"
                    : "btn-ghost text-base-content/70 hover:text-base-content"
                }`}
                onClick={() => selectTheme(value)}
              >
                {label}
              </button>
            ))}
          </fieldset>
        </section>

        {/* 分析模型紧随外观之后；版本与更新（UpdateSection）跟在最后。 */}
        <section
          aria-labelledby="models-title"
          className="mt-5 border-t border-base-content/10 pt-4"
        >
          <h4 id="models-title" className="text-sm font-semibold">
            分析模型
          </h4>
          <p className="mt-1 text-sm leading-relaxed text-base-content/65">
            主谓宾着色需要句子分析模型。下载一次，之后应用即可离线使用。两个版本可以同时存在
            于磁盘上——随时切换。
          </p>

          {status?.manifestError && (
            <div role="alert" className="alert alert-warning mt-4 text-sm">
              <span>
                无法读取下载大小（{status.manifestError}）。你仍可安装模型，只是无法提前知道 大小。
              </span>
            </div>
          )}

          {problem && (
            <div role="alert" className="alert alert-error mt-4 text-sm">
              <span className="break-words">{problem}</span>
            </div>
          )}

          {status?.warning && (
            <div role="status" className="alert alert-warning mt-4 text-sm">
              <span className="break-words">{status.warning}</span>
            </div>
          )}

          {status === null ? (
            <div className="mt-4 space-y-3">
              <div className="skeleton h-16 rounded-box" />
              <div className="skeleton h-16 rounded-box" />
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {status.variants.map((variant) => {
                const isInstalled = status.installed.includes(variant.id);
                const isActive = status.active === variant.id;
                const isDownloading = op?.kind === "install" && op.variant === variant.id;
                const isActivating = op?.kind === "activate" && op.variant === variant.id;
                const isRemoving = op?.kind === "remove" && op.variant === variant.id;
                const progress = isDownloading ? op.progress : null;
                const totalBytes = progress?.total || variant.bytes;
                const ratio =
                  isDownloading && progress?.variant === variant.id && totalBytes > 0
                    ? Math.min(1, progress.done / totalBytes)
                    : 0;
                const displaySize = isInstalled ? variant.size || variant.bytes : variant.bytes;
                return (
                  <li key={variant.id}>
                    <div
                      className={`card w-full border bg-base-100 text-left transition-colors duration-200 ${
                        isActive ? "border-primary" : "border-base-content/10"
                      }`}
                    >
                      <div className="card-body gap-2 p-4">
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <h5 className="text-sm font-semibold">{variant.label}</h5>
                              {isActive && (
                                <span className="badge badge-primary badge-xs">使用中</span>
                              )}
                            </div>
                            <p className="mt-0.5 text-xs leading-relaxed text-base-content/60">
                              {variant.description}
                            </p>
                            <p className="mt-1 text-xs text-base-content/50">
                              {formatBytes(displaySize)}
                              {variant.partial > 0 && !isInstalled && (
                                <> · 已下载 {formatBytes(variant.partial)} </>
                              )}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {isInstalled ? (
                              <>
                                {!isActive && (
                                  <button
                                    type="button"
                                    className="btn btn-primary btn-soft btn-sm"
                                    disabled={op !== null}
                                    onClick={() => void activate(variant.id)}
                                  >
                                    {isActivating ? (
                                      <span className="loading loading-spinner loading-xs" />
                                    ) : (
                                      "启用"
                                    )}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm text-error"
                                  disabled={op !== null}
                                  onClick={() => void remove(variant.id)}
                                >
                                  {isRemoving ? (
                                    <span className="loading loading-spinner loading-xs" />
                                  ) : (
                                    "移除"
                                  )}
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                disabled={op !== null}
                                onClick={() => void install(variant.id)}
                              >
                                {isDownloading ? (
                                  <span className="loading loading-spinner loading-xs" />
                                ) : variant.partial > 0 ? (
                                  "继续下载"
                                ) : (
                                  "下载"
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
                              aria-label={`正在下载 ${variant.label}`}
                            />
                            <p className="text-xs text-base-content/55">
                              {progress
                                ? `${progress.file} · ${Math.round(ratio * 100)}%`
                                : "开始中…"}
                            </p>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="mt-4 text-xs leading-relaxed text-base-content/50">
            {status !== null && status.installed.length > 0
              ? "移除模型不会影响你的书；它们只是不再着色，直到你下载或启用另一个模型。"
              : "两个版本都在本机运行，不会上传任何内容。"}
          </p>
        </section>

        <UpdateSection open={open} onBusyChange={setUpdateBusy} />

        <div className="modal-action">
          <button type="button" className="btn" onClick={onClose} disabled={isBusy}>
            {isBusy ? "处理中…" : "完成"}
          </button>
        </div>
      </div>
      <ModalBackdrop onClose={() => !isBusy && onClose()} />
    </dialog>
  );
}
