import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import {
  type ExportReport,
  exportBook,
  fileName,
  fileNameOf,
  type Stylesheet,
} from "../lib/exporting";
import { epubFilter } from "../lib/picker";
import { message } from "../lib/reading";
import { useHistoryOverlay } from "../lib/router";
import { ModalBackdrop, useDialog } from "./dialog";

interface StylesheetOption {
  readonly label: string;
  readonly summary: string;
  readonly heading: string;
  readonly detail: string;
}

const STYLESHEET_ORDER: readonly Stylesheet[] = ["inline", "external"];

/**
 * Single source of truth for the stylesheet choices and their explanations.
 * Keyed by `Stylesheet` so any new mode must declare both its short radio copy
 * and its detailed explanation at compile time.
 */
const STYLESHEET_OPTIONS: Record<Stylesheet, StylesheetOption> = {
  inline: {
    label: "内联",
    summary: "颜色样式写进每一章，单文件即可阅读",
    heading: "内联（默认推荐）",
    detail:
      "把配色规则以 <style> 写入每个章节的 XHTML。各章自带样式，兼容性最好（部分阅读器忽略外链样式或拆章查看时也能保留颜色）；但若需手动改配色，要逐章修改。",
  },
  external: {
    label: "外联",
    summary: "样式存为书内单独的 biocn.css，方便修改配色",
    heading: "外联",
    detail:
      "在 EPUB 内部生成一份统一的 biocn.css，各章节通过 <link> 引用。无重复样式、结构更精简；之后若用 Calibre、Sigil 等工具自定义主谓宾或深色模式配色，只改这一份文件即可生效全书。",
  },
};

interface Props {
  /** The book to export, and the title used for the default file name. */
  id: string;
  title: string;
  onClose: () => void;
}

type Phase =
  | { kind: "choosing" }
  | { kind: "picking" }
  | { kind: "working" }
  | { kind: "done"; report: ExportReport; path: string }
  | { kind: "failed"; problem: string };

/**
 * The export dialog: pick where the colors live, pick a file, write it.
 *
 * The choice between an inline and an external stylesheet is a choice about the
 * *book*, not about this run, so it is made before the save dialog: it decides
 * what the file contains, and a file picked first would have to be rewritten
 * after the fact to change the answer.
 */
export function ExportDialog({ id, title, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const [stylesheet, setStylesheet] = useState<Stylesheet>("inline");
  const [phase, setPhase] = useState<Phase>({ kind: "choosing" });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Mounted only while a book is being exported (BookTile renders it only for
  // that), so it opens once on mount and never toggles afterwards.
  useDialog(dialog, true);

  const busy = phase.kind === "picking" || phase.kind === "working";

  const run = async () => {
    if (busy) return;
    setPhase({ kind: "picking" });
    let target: string | null;
    try {
      target = await save({
        title: "导出着色后的图书",
        // A title is not a file name: slashes and colons in it would either be
        // rejected by the OS or silently change the path.
        defaultPath: fileName(title),
        filters: [epubFilter()],
      });
    } catch (error) {
      if (!mounted.current) return;
      // The picker itself can fail (no document provider, a refused
      // permission). That is still a failure to explain, not a silent no-op.
      setPhase({ kind: "failed", problem: message(error) });
      return;
    }
    if (!mounted.current) return;
    // Cancelling the save dialog is not a failure: nothing was attempted.
    if (target === null) {
      setPhase({ kind: "choosing" });
      return;
    }

    setPhase({ kind: "working" });
    try {
      const report = await exportBook(id, target, stylesheet);
      if (!mounted.current) return;
      setPhase({
        kind: "done",
        report,
        // The path, because a save dialog that opened in the last used folder
        // leaves the user to guess where this one went.
        path: fileNameOf(target),
      });
    } catch (error) {
      if (!mounted.current) return;
      setPhase({ kind: "failed", problem: message(error) });
    }
  };

  const close = () => {
    // Closing while picking or mid-write would either orphan an OS picker or
    // drop feedback for an in-flight export.
    if (busy) return;
    onClose();
  };

  useHistoryOverlay(true, close, !busy);

  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby={`export-title-${id}`}
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <div className="modal-box max-w-md">
        <h3 id={`export-title-${id}`} className="text-base font-semibold">
          导出《{title}》
        </h3>

        {phase.kind === "done" ? (
          <Report phase={phase} />
        ) : (
          <>
            <p className="mt-2 text-sm text-base-content/70">
              全书着色结果会写入新的 EPUB 副本，原书不会被改动。
            </p>
            <StylesheetPicker
              id={id}
              value={stylesheet}
              disabled={busy}
              onChange={setStylesheet}
            />

            {phase.kind === "failed" && (
              <div role="alert" className="alert alert-error mt-4 text-sm">
                <span className="break-words">{phase.problem}</span>
              </div>
            )}
          </>
        )}

        <div className="modal-action">
          {phase.kind === "done" ? (
            <button type="button" className="btn btn-primary" onClick={close}>
              完成
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void run()}
              >
                {busy ? (
                  <span className="loading loading-spinner loading-sm" aria-hidden="true" />
                ) : null}
                {phase.kind === "working"
                  ? "正在导出…"
                  : phase.kind === "picking"
                    ? "正在选择位置…"
                    : "选择位置并导出"}
              </button>
            </>
          )}
        </div>
      </div>
      <ModalBackdrop onClose={close} />
    </dialog>
  );
}

/** Radio selector for inline vs. external EPUB CSS, with an expandable guide. */
function StylesheetPicker({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: Stylesheet;
  disabled: boolean;
  onChange: (next: Stylesheet) => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const legendId = `export-style-legend-${id}`;
  const infoId = `export-style-info-${id}`;

  return (
    <fieldset className="fieldset mt-4" aria-labelledby={legendId}>
      <legend className="fieldset-legend">
        <span id={legendId}>CSS 样式</span>
        <button
          type="button"
          className={`btn btn-ghost btn-circle btn-xs ${
            showInfo ? "text-info" : "text-base-content/60"
          }`}
          aria-label="了解内联与外联样式的区别"
          title="了解内联与外联样式的区别"
          aria-expanded={showInfo}
          aria-controls={infoId}
          onClick={() => setShowInfo((open) => !open)}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            className="size-4"
          >
            <circle cx="10" cy="10" r="7.5" />
            <path strokeLinecap="round" d="M10 9v4.5" />
            <circle cx="10" cy="6.25" r="0.85" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </legend>

      {showInfo && <StylesheetInfo id={infoId} />}

      {STYLESHEET_ORDER.map((kind) => {
        const option = STYLESHEET_OPTIONS[kind];
        return (
          <label key={kind} className="label cursor-pointer justify-start gap-3">
            <input
              type="radio"
              name={`stylesheet-${id}`}
              className="radio radio-primary radio-sm"
              value={kind}
              checked={value === kind}
              disabled={disabled}
              onChange={() => onChange(kind)}
            />
            <span className="flex flex-col">
              <span className="text-sm">{option.label}</span>
              <span className="text-xs text-base-content/55">{option.summary}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** Explains how inline and external EPUB CSS differ in practice. */
function StylesheetInfo({ id }: { id: string }) {
  return (
    <div
      id={id}
      role="note"
      className="alert alert-info alert-soft mt-1 mb-1 text-xs leading-relaxed"
    >
      <div className="space-y-1.5 text-base-content/80">
        <p className="font-medium text-base-content">
          两种方式都会导出单个 .epub 文件，区别在于配色 CSS 的存放位置：
        </p>
        {STYLESHEET_ORDER.map((kind) => {
          const option = STYLESHEET_OPTIONS[kind];
          return (
            <p key={kind}>
              <strong className="text-base-content">{option.heading}：</strong>
              {option.detail}
            </p>
          );
        })}
      </div>
    </div>
  );
}

/** What the export did, in the terms that matter: how much of it is colored. */
function Report({ phase }: { phase: Extract<Phase, { kind: "done" }> }) {
  const { report, path } = phase;
  const all = report.skipped === 0;
  return (
    <div className="mt-3">
      <div role="status" className="alert alert-success text-sm">
        <span>已导出到 {path}</span>
      </div>
      <p className="mt-3 text-sm text-base-content/70">
        {all
          ? `${report.chapters} 章全部带上颜色。`
          : `${report.colored} 章带上了颜色，${report.skipped} 章还没有着色，保持原样。`}
      </p>
      {!all && (
        <p className="mt-1 text-xs text-base-content/55">
          先对这本书执行「着色全书」，再导出，就能得到完整的书。
        </p>
      )}
    </div>
  );
}
