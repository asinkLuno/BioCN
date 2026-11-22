import { type CSSProperties, createElement, type ReactNode, useEffect, useRef } from "react";
import type { FootnoteNode, SvoRole } from "../lib/footnote";
import type { AnchorRect } from "../lib/readerBridge";
import type { ReaderPrefs, ReaderTheme } from "../lib/readerPrefs";

export interface FootnoteView {
  label: string;
  nodes: FootnoteNode[];
  targetChapterIndex: number | null;
  targetAnchor: string;
  sameChapter: boolean;
  /** Host viewport coordinates of the footnote reference link, or null to fallback. */
  rect: AnchorRect | null;
  /** True when opened by explicit click/tap (stays open until dismissed); false on hover. */
  pinned: boolean;
}

export interface PopoverLayout {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
  placement: "top" | "bottom";
}

const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 8;
const MAX_CARD_WIDTH = 384;
const MIN_CARD_WIDTH = 220;
const PREFERRED_ABOVE_HEIGHT = 180;

/**
 * Pure layout calculation for a floating footnote hovercard so it anchors near
 * the reference link, flips above/below based on space, and never clips off-screen.
 */
export function computeFootnotePopoverLayout(
  anchor: AnchorRect | null,
  viewport: { width: number; height: number },
): PopoverLayout {
  const width = Math.min(
    MAX_CARD_WIDTH,
    Math.max(MIN_CARD_WIDTH, Math.round(viewport.width - VIEWPORT_MARGIN * 2)),
  );
  const maxCardHeight = Math.max(140, Math.round(viewport.height * 0.48));

  if (!anchor) {
    return {
      left: Math.max(VIEWPORT_MARGIN, Math.round((viewport.width - width) / 2)),
      width,
      bottom: 24,
      maxHeight: maxCardHeight,
      placement: "top",
    };
  }

  const center = (anchor.left + anchor.right) / 2;
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN - width);
  const left = Math.round(Math.min(maxLeft, Math.max(VIEWPORT_MARGIN, center - width / 2)));

  const spaceAbove = Math.max(0, anchor.top - VIEWPORT_MARGIN - ANCHOR_GAP);
  const spaceBelow = Math.max(0, viewport.height - anchor.bottom - VIEWPORT_MARGIN - ANCHOR_GAP);

  if (spaceAbove >= PREFERRED_ABOVE_HEIGHT || spaceAbove >= spaceBelow) {
    return {
      left,
      width,
      bottom: Math.max(VIEWPORT_MARGIN, Math.round(viewport.height - anchor.top + ANCHOR_GAP)),
      maxHeight: Math.min(maxCardHeight, Math.max(120, Math.round(spaceAbove))),
      placement: "top",
    };
  }

  return {
    left,
    width,
    top: Math.max(VIEWPORT_MARGIN, Math.round(anchor.bottom + ANCHOR_GAP)),
    maxHeight: Math.min(maxCardHeight, Math.max(120, Math.round(spaceBelow))),
    placement: "bottom",
  };
}

interface Props {
  footnote: FootnoteView;
  prefs: ReaderPrefs;
  effectiveTheme: ReaderTheme;
  onClose: () => void;
  onJumpToTarget: () => void;
  onNavigateInternal: (path: string, anchor: string | null) => void;
  onOpenExternal: (href: string) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
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
      return "mb-2 last:mb-0";
    case "blockquote":
      return "my-1.5 border-l-2 border-primary/40 pl-3 opacity-85";
    case "ul":
      return "my-1.5 list-disc pl-5 space-y-1";
    case "ol":
      return "my-1.5 list-decimal pl-5 space-y-1";
    case "dl":
      return "my-1.5 space-y-1";
    case "dt":
      return "font-semibold";
    case "dd":
      return "pl-3 opacity-90";
    case "pre":
      return "my-1.5 overflow-x-auto rounded bg-base-200 p-2 text-xs";
    case "code":
      return "rounded bg-base-200 px-1 py-0.5 text-[0.9em]";
    case "table":
      return "table table-xs my-1.5 w-full";
    case "figure":
      return "my-1.5 text-center";
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
            className="my-2 max-h-52 max-w-full rounded object-contain"
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
 * Floating non-modal footnote hovercard anchored near the reference link in the
 * reader host layer so hovering or tapping a footnote never dims or blocks the page.
 */
export function ReaderFootnotePopover({
  footnote,
  prefs,
  effectiveTheme,
  onClose,
  onJumpToTarget,
  onNavigateInternal,
  onOpenExternal,
  onPointerEnter,
  onPointerLeave,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Dismiss when clicking/tapping outside the floating card or resizing the viewport
  // (reflow shifts the iframe anchor rect).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!cardRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 768;
  const layout = computeFootnotePopoverLayout(footnote.rect, {
    width: viewportWidth,
    height: viewportHeight,
  });

  const canJump = footnote.sameChapter || footnote.targetChapterIndex !== null;
  const cardTheme =
    effectiveTheme === "dark"
      ? "dark"
      : effectiveTheme === "light" || effectiveTheme === "sepia"
        ? "light"
        : undefined;

  // Match sepia paper surface when sepia theme is active (daisyUI has no sepia token).
  const surfaceClass =
    effectiveTheme === "sepia" ? "bg-[#f4ede0] text-[#362d24]" : "bg-base-100 text-base-content";

  const bodyFontSize = Math.min(18, Math.max(13, prefs.fontSize - 2));
  const bodyStyle: CSSProperties = {
    fontSize: `${bodyFontSize}px`,
    lineHeight: Math.min(1.9, Math.max(1.55, prefs.lineHeight - 0.15)),
    maxHeight: `${Math.max(80, layout.maxHeight - 52)}px`,
    ...(prefs.fontFamily === "serif"
      ? {
          fontFamily:
            '"Source Han Serif SC", "Noto Serif SC", "Songti SC", "STSong", "SimSun", Georgia, serif',
        }
      : {}),
  };

  const positionStyle: CSSProperties = {
    left: `${layout.left}px`,
    width: `${layout.width}px`,
    ...(layout.top !== undefined ? { top: `${layout.top}px` } : {}),
    ...(layout.bottom !== undefined ? { bottom: `${layout.bottom}px` } : {}),
  };

  const showLabel = footnote.label && footnote.label !== "注释";

  return (
    <div
      ref={cardRef}
      role="region"
      aria-labelledby="reader-footnote-title"
      data-theme={cardTheme}
      style={positionStyle}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      className={`card card-border fixed z-40 border-base-content/15 shadow-xl ${surfaceClass}`}
    >
      <div className="card-body gap-2 p-3.5">
        <div className="flex items-center justify-between gap-2">
          <h3
            id="reader-footnote-title"
            className="flex min-w-0 items-center gap-1.5 text-xs font-medium"
          >
            <span className="badge badge-soft badge-primary badge-xs shrink-0">注释</span>
            {showLabel && <span className="truncate opacity-70">{footnote.label}</span>}
          </h3>
          <div className="flex shrink-0 items-center gap-1">
            {canJump && (
              <button
                type="button"
                className="btn btn-ghost btn-xs font-normal opacity-70 hover:opacity-100"
                onClick={onJumpToTarget}
              >
                跳转到注释处
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-xs btn-circle"
              aria-label="关闭注释"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
        </div>

        <div className="overflow-y-auto break-words pr-1" style={bodyStyle}>
          {renderNodes(
            footnote.nodes,
            { prefs, effectiveTheme, onNavigateInternal, onOpenExternal },
            "fn",
          )}
        </div>
      </div>
    </div>
  );
}
