import { type CSSProperties, createElement, type ReactNode, useRef } from "react";
import type { FootnoteNode, SvoRole } from "../lib/footnote";
import type { ReaderPrefs, ReaderTheme } from "../lib/readerPrefs";
import { ModalBackdrop, useDialog } from "./dialog";

export interface FootnoteView {
  label: string;
  nodes: FootnoteNode[];
  targetChapterIndex: number | null;
  targetAnchor: string;
  sameChapter: boolean;
}

interface Props {
  footnote: FootnoteView;
  prefs: ReaderPrefs;
  effectiveTheme: ReaderTheme;
  onClose: () => void;
  onJumpToTarget: () => void;
  onNavigateInternal: (path: string, anchor: string | null) => void;
  onOpenExternal: (href: string) => void;
}

function svoColorFor(role: SvoRole, prefs: ReaderPrefs, effectiveTheme: ReaderTheme): string {
  const custom = prefs.svoColors[role];
  if (custom) return custom;
  if (effectiveTheme === "sepia") {
    switch (role) {
      case "subject":
        return "#b34808";
      case "predicate":
        return "#147054";
      case "object":
        return "#5b5299";
    }
  }
  switch (role) {
    case "subject":
      return "var(--biocn-helix-o)";
    case "predicate":
      return "var(--biocn-helix-g)";
    case "object":
      return "var(--biocn-helix-p)";
  }
}

function elementClassName(tag: string): string | undefined {
  switch (tag) {
    case "p":
      return "mb-2.5 last:mb-0";
    case "blockquote":
      return "my-2 border-l-2 border-primary/40 pl-3 opacity-85";
    case "ul":
      return "my-2 list-disc pl-5 space-y-1";
    case "ol":
      return "my-2 list-decimal pl-5 space-y-1";
    case "dl":
      return "my-2 space-y-1";
    case "dt":
      return "font-semibold";
    case "dd":
      return "pl-3 opacity-90";
    case "pre":
      return "my-2 overflow-x-auto rounded bg-base-200 p-2 text-xs";
    case "code":
      return "rounded bg-base-200 px-1 py-0.5 text-[0.9em]";
    case "table":
      return "table table-xs my-2 w-full";
    case "figure":
      return "my-2 text-center";
    case "figcaption":
      return "mt-1 text-xs opacity-70";
    default:
      return undefined;
  }
}

interface RenderHandlers {
  prefs: ReaderPrefs;
  effectiveTheme: ReaderTheme;
  onNavigateInternal: (path: string, anchor: string | null) => void;
  onOpenExternal: (href: string) => void;
}

function renderNodes(nodes: FootnoteNode[], handlers: RenderHandlers, prefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${prefix}-${i}`;
    switch (node.kind) {
      case "text":
        return node.text;
      case "br":
        return <br key={key} />;
      case "hr":
        return <hr key={key} className="my-2 border-base-content/15" />;
      case "img":
        return (
          <img
            key={key}
            src={node.src}
            alt={node.alt}
            className="my-2 max-h-60 max-w-full rounded object-contain"
          />
        );
      case "svo": {
        const style: CSSProperties | undefined = handlers.prefs.coloringEnabled
          ? { color: svoColorFor(node.role, handlers.prefs, handlers.effectiveTheme) }
          : undefined;
        return (
          <span key={key} style={style}>
            {renderNodes(node.children, handlers, key)}
          </span>
        );
      }
      case "link": {
        if (node.linkType === "external") {
          return (
            <a
              key={key}
              href={node.href}
              title={node.title}
              className="link link-primary break-words"
              onClick={(event) => {
                event.preventDefault();
                handlers.onOpenExternal(node.href);
              }}
            >
              {renderNodes(node.children, handlers, key)}
            </a>
          );
        }
        return (
          <a
            key={key}
            href={`#${node.anchor ?? ""}`}
            title={node.title}
            className="link link-primary break-words"
            onClick={(event) => {
              event.preventDefault();
              handlers.onNavigateInternal(node.path, node.anchor);
            }}
          >
            {renderNodes(node.children, handlers, key)}
          </a>
        );
      }
      case "element": {
        const props: Record<string, unknown> = { key };
        const className = elementClassName(node.tag);
        if (className) props.className = className;
        if (node.title) props.title = node.title;
        if (node.colSpan) props.colSpan = node.colSpan;
        if (node.rowSpan) props.rowSpan = node.rowSpan;
        return createElement(node.tag, props, renderNodes(node.children, handlers, key));
      }
      default: {
        const exhaustive: never = node;
        return exhaustive;
      }
    }
  });
}

/**
 * Footnote popup shown in the reader host layer so footnotes never disrupt the
 * current scroll/page position and never get clipped by paginated columns.
 */
export function ReaderFootnoteDialog({
  footnote,
  prefs,
  effectiveTheme,
  onClose,
  onJumpToTarget,
  onNavigateInternal,
  onOpenExternal,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useDialog(dialogRef, true);

  const canJump = footnote.sameChapter || footnote.targetChapterIndex !== null;
  const dialogTheme =
    effectiveTheme === "dark"
      ? "dark"
      : effectiveTheme === "light" || effectiveTheme === "sepia"
        ? "light"
        : undefined;

  // Match sepia paper surface when sepia theme is active (daisyUI has no sepia token).
  const surfaceClass =
    effectiveTheme === "sepia" ? "bg-[#f4ede0] text-[#362d24]" : "bg-base-100 text-base-content";

  const bodyFontSize = Math.min(19, Math.max(14, prefs.fontSize - 1));
  const bodyStyle: CSSProperties = {
    fontSize: `${bodyFontSize}px`,
    lineHeight: Math.min(2.0, Math.max(1.65, prefs.lineHeight - 0.1)),
    ...(prefs.fontFamily === "serif"
      ? {
          fontFamily:
            '"Source Han Serif SC", "Noto Serif SC", "Songti SC", "STSong", "SimSun", Georgia, serif',
        }
      : {}),
  };

  const showLabel = footnote.label && footnote.label !== "注释";

  return (
    <dialog
      ref={dialogRef}
      data-theme={dialogTheme}
      className="modal modal-bottom sm:modal-middle"
      aria-labelledby="reader-footnote-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className={`modal-box max-w-lg border border-base-content/10 shadow-xl ${surfaceClass}`}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3
            id="reader-footnote-title"
            className="flex min-w-0 items-center gap-2 text-sm font-medium"
          >
            <span className="badge badge-soft badge-primary badge-sm shrink-0">注释</span>
            {showLabel && <span className="truncate opacity-70">{footnote.label}</span>}
          </h3>
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-circle shrink-0"
            aria-label="关闭注释"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="max-h-[60dvh] overflow-y-auto break-words pr-1" style={bodyStyle}>
          {renderNodes(
            footnote.nodes,
            { prefs, effectiveTheme, onNavigateInternal, onOpenExternal },
            "fn",
          )}
        </div>

        <div className="modal-action mt-4">
          {canJump && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onJumpToTarget}>
              跳转到注释处
            </button>
          )}
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
      <ModalBackdrop onClose={onClose} />
    </dialog>
  );
}
