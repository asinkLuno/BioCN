import { useEffect, useRef, useState } from "react";
import {
  formatBytes,
  modelsActivate,
  modelsInstall,
  modelsRemove,
  modelsStatus,
  onModelProgress,
  type ModelProgress,
  type ModelStatus,
  type VariantId,
} from "../lib/models";
import { message } from "../lib/reading";

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
export function ModelSheet({ open, onClose, onChange = noop }: Props) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<"install" | "activate" | "remove" | null>(null);
  const [working, setWorking] = useState<VariantId>("int8");
  const [progress, setProgress] = useState<ModelProgress | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

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
    setBusy("install");
    setWorking(variant);
    setProblem(null);
    setProgress(null);
    // Subscribe before the command: a debug build copies from disk and can
    // finish every file before a listener attached afterwards is told.
    const unlisten = await onModelProgress((event) => setProgress(event));
    try {
      setStatus(await modelsInstall(variant));
      onChange();
    } catch (error) {
      setProblem(message(error));
      // A failed download keeps its partial file; re-reading the status is what
      // puts the "resume" size on screen.
      setStatus(await modelsStatus().catch(() => null));
    } finally {
      unlisten();
      setBusy(null);
      setProgress(null);
    }
  };

  const activate = async (variant: VariantId) => {
    setWorking(variant);
    setBusy("activate");
    setProblem(null);
    try {
      setStatus(await modelsActivate(variant));
      onChange();
    } catch (error) {
      setProblem(message(error));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (variant: VariantId) => {
    setBusy("remove");
    setWorking(variant);
    setProblem(null);
    try {
      setStatus(await modelsRemove(variant));
      onChange();
    } catch (error) {
      setProblem(message(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby="models-title"
      onClose={onClose}
      // Escape must not dismiss the sheet mid-download: the transfer keeps
      // running with nothing on screen to show it or to cancel it.
      onCancel={(event) => {
        if (busy !== null) event.preventDefault();
        else onClose();
      }}
    >
      <div className="modal-box max-w-lg">
        <h3 id="models-title" className="text-base font-semibold">
          Analysis models
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-base-content/65">
          主谓宾 coloring needs a sentence-analysis model. Download it once; after that the
          app works offline. Both variants can live on disk together — switch any time.
        </p>

        {status?.manifestError && (
          <div role="alert" className="alert alert-warning mt-4 text-sm">
            <span>
              Couldn’t read the download sizes ({status.manifestError}). You can still install a
              model; the size just isn’t known in advance.
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
              const isDownloading = busy === "install" && working === variant.id;
              const isRemoving = busy === "remove" && working === variant.id;
              // `done` counts every file of the variant, so it is already the
              // number this bar wants: the Rust side adds the bytes of the
              // files it has finished to the ones it is writing now.
              const ratio =
                isDownloading && progress?.variant === variant.id && variant.bytes > 0
                  ? Math.min(1, progress.done / variant.bytes)
                  : 0;
              return (
                <li key={variant.id}>
                  {/* The active card is outlined in primary. Clicking an
                      installed card switches to it; hovering darkens it so the
                      clickability is visible. */}
                  <button
                    type="button"
                    disabled={!isInstalled || isActive || busy !== null}
                    onClick={() => void activate(variant.id)}
                    className={`card border w-full bg-base-100 text-left transition-colors duration-200 hover:bg-base-200 ${
                      isActive ? "border-primary" : "border-base-content/10"
                    }`}
                  >
                    <div className="card-body gap-2 p-4">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <h4 className="text-sm font-semibold">{variant.label}</h4>
                          <p className="mt-0.5 text-xs leading-relaxed text-base-content/60">
                            {variant.description}
                          </p>
                          <p className="mt-1 text-xs text-base-content/50">
                            {formatBytes(variant.bytes)}
                            {variant.partial > 0 && !isInstalled && (
                              <> · {formatBytes(variant.partial)} already downloaded</>
                            )}
                          </p>
                        </div>
                        {isInstalled ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm text-error"
                            disabled={busy !== null}
                            onClick={(event) => {
                              // The card is one big button; removal must not
                              // trigger the switch underneath it.
                              event.stopPropagation();
                              void remove(variant.id);
                            }}
                          >
                            {isRemoving ? <span className="loading loading-spinner loading-xs" /> : "Remove"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={busy !== null}
                            onClick={() => void install(variant.id)}
                          >
                            {isDownloading ? (
                              <span className="loading loading-spinner loading-xs" />
                            ) : variant.partial > 0 ? (
                              "Resume"
                            ) : (
                              "Download"
                            )}
                          </button>
                        )}
                      </div>
                      {isDownloading && (
                        <>
                          <progress
                            className="progress progress-primary w-full"
                            value={ratio}
                            max={1}
                            aria-label={`Downloading ${variant.label}`}
                          />
                          <p className="text-xs text-base-content/55">
                            {progress ? `${progress.file} · ${Math.round(ratio * 100)}%` : "Starting…"}
                          </p>
                        </>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-4 text-xs leading-relaxed text-base-content/50">
          {status !== null && status.installed.length > 0
            ? "Removing a model keeps your books; they just stop being colored until you download or activate another one."
            : "Both variants run on this device. Nothing is uploaded."}
        </p>

        <div className="modal-action">
          <button type="button" className="btn" onClick={onClose} disabled={busy !== null}>
            {busy !== null ? "Working…" : "Done"}
          </button>
        </div>
      </div>
      <button
        type="button"
        aria-label="Close"
        className="modal-backdrop"
        onClick={() => busy === null && onClose()}
      />
    </dialog>
  );
}
