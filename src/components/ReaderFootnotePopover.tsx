import {
  type CSSProperties,
  createElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
  maxWidth: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
  placement: "top" | "bottom";
  /** Horizontal offset (px from pop-up left edge) for the pointer arrow, or null when unanchored. */
  arrowLeft: number | null;
}

const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 10;
const MAX_POPUP_WIDTH = 340;
const MIN_POPUP_WIDTH = 200;
const PREFERRED_ABOVE_HEIGHT = 160;
const ARROW_INSET = 16;

/**
 * Pure layout calculation for a floating footnote pop-up bubble: anchors tightly
 * over/under the reference link, computes the pointer arrow offset, flips when
 * near the top edge, and clamps horizontally inside the viewport.
 */
export function computeFootnotePopoverLayout(
  anchor: AnchorRect | null,
  viewport: { width: number; height: number },
  measuredWidth?: number,
): PopoverLayout {
  const maxWidth = Math.min(
    MAX_POPUP_WIDTH,
    Math.max(MIN_POPUP_WIDTH, Math.round(viewport.width - VIEWPORT_MARGIN * 2)),
  );
  const effectiveWidth =
    measuredWidth && measuredWidth > 0 ? Math.min(Math.round(measuredWidth), maxWidth) : maxWidth;
  const maxCardHeight = Math.max(140, Math.round(viewport.height * 0.45));

  if (!anchor) {
    return {
      left: Math.max(VIEWPORT_MARGIN, Math.round((viewport.width - effectiveWidth) / 2)),
      maxWidth,
      bottom: 24,
      maxHeight: maxCardHeight,
      placement: "top",
      arrowLeft: null,
    };
  }

  const center = (anchor.left + anchor.right) / 2;
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN - effectiveWidth);
  const left = Math.round(Math.min(maxLeft, Math.max(VIEWPORT_MARGIN, center - effectiveWidth / 2)));
  const arrowLeft = Math.round(
    Math.min(effectiveWidth - ARROW_INSET, Math.max(ARROW_INSET, center - left)),
  );

  const spaceAbove = Math.max(0, anchor.top - VIEWPORT_MARGIN - ANCHOR_GAP);
  const spaceBelow = Math.max(0, viewport.height - anchor.bottom - VIEWPORT_MARGIN - ANCHOR_GAP);

  if (spaceAbove >= PREFERRED_ABOVE_HEIGHT || spaceAbove >= spaceBelow) {
    return {
      left,
      maxWidth,
      bottom: Math.max(VIEWPORT_MARGIN, Math.round(viewport.height - anchor.top + ANCHOR_GAP)),
      maxHeight: Math.min(maxCardHeight, Math.max(120, Math.round(spaceAbove))),
      placement: "top",
      arrowLeft,
    };
  }

  return {
    left,
    maxWidth,
    top: Math.max(VIEWPORT_MARGIN, Math.round(anchor.bottom + ANCHOR_GAP)),
    maxHeight: Math.min(maxCardHeight, Math.max(120, Math.round(spaceBelow))),
    placement: "bottom",
    arrowLeft,
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
      return "mb-1.5 last:mb-0";
    case "blockquote":
      return "my-1.5 border-l-2 border-primary/40 pl-2.5 opacity-85";
    case "ul":
      return "my-1.5 list-disc pl-4 space-y-0.5";
    case "ol":
      return "my-1.5 list-decimal pl-4 space-y-0.5";
    case "dl":
      return "my-1.5 space-y-0.5";
    case "dt":
      return "font-semibold";
    case "dd":
      return "pl-2.5 opacity-90";
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
        return <hr key={key} className="my-1.5 border-base-content/15" />;
      case "img":
        return (
          <img
            key={key}
            src={node.src}
            alt={node.alt}
            className="my-1.5 max-h-48 max-w-full rounded object-contain"
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
 * Anchored floating footnote pop-up bubble with a pointer arrow aimed at the
 * reference marker, translucent elevated surface, and content-first layout.
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
  const [measuredWidth, setMeasuredWidth] = useState<number | undefined>(undefined);

  // Measure natural bubble width before paint so compact notes center tightly over the anchor.
  useLayoutEffect(() => {
    const width = cardRef.current?.offsetWidth;
    setMeasuredWidth(width && width > 0 ? width : undefined);
  }, [footnote]);

  // Dismiss when clicking/tapping outside the pop-up or resizing the viewport
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
  const layout = computeFootnotePopoverLayout(
    footnote.rect,
    { width: viewportWidth, height: viewportHeight },
    measuredWidth,
  );

  const canJump = footnote.sameChapter || footnote.targetChapterIndex !== null;
  const showLabel = Boolean(footnote.label && footnote.label !== "注释");
  const showFooter = showLabel || canJump;

  const cardTheme =
    effectiveTheme === "dark"
      ? "dark"
      : effectiveTheme === "light" || effectiveTheme === "sepia"
        ? "light"
        : undefined;

  // Match sepia paper surface when sepia theme is active (daisyUI has no sepia token).
  // Use the same opaque surface on bubble and arrow so they join with zero seam.
  const isSepia = effectiveTheme === "sepia";
  const surfaceClass = isSepia
    ? "bg-[#f6efe2] text-[#362d24] ring-[#362d24]/15"
    : "bg-base-100 text-base-content ring-base-content/12";
  const arrowSurfaceClass = isSepia
    ? "bg-[#f6efe2] border-[#362d24]/15"
    : "bg-base-100 border-base-content/12";

  const bodyFontSize = Math.min(16, Math.max(13, prefs.fontSize - 3));
  const bodyStyle: CSSProperties = {
    fontSize: `${bodyFontSize}px`,
    lineHeight: Math.min(1.75, Math.max(1.5, prefs.lineHeight - 0.2)),
    maxHeight: `${Math.max(80, layout.maxHeight - (showFooter ? 48 : 20))}px`,
    ...(prefs.fontFamily === "serif"
      ? {
          fontFamily:
            '"Source Han Serif SC", "Noto Serif SC", "Songti SC", "STSong", "SimSun", Georgia, serif',
        }
      : {}),
  };

  const positionStyle: CSSProperties = {
    left: `${layout.left}px`,
    maxWidth: `${layout.maxWidth}px`,
    ...(layout.top !== undefined ? { top: `${layout.top}px` } : {}),
    ...(layout.bottom !== undefined ? { bottom: `${layout.bottom}px` } : {}),
  };

  const animClass = layout.placement === "top" ? "biocn-popover-top" : "biocn-popover-bottom";

  return (
    <div
      ref={cardRef}
      role="region"
      aria-label={showLabel ? `注释 ${footnote.label}` : "注释"}
      data-placement={layout.placement}
      data-theme={cardTheme}
      style={positionStyle}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      className={`card fixed z-40 w-max min-w-44 overflow-visible shadow-2xl ring-1 ${surfaceClass} ${animClass}`}
    >
      {layout.arrowLeft !== null && (
        <span
          aria-hidden="true"
          data-popover-arrow=""
          style={{ left: `${layout.arrowLeft}px` }}
          className={`pointer-events-none absolute size-2.5 -translate-x-1/2 rotate-45 ${arrowSurfaceClass} ${
            layout.placement === "top"
              ? "-bottom-[5px] border-r border-b"
              : "-top-[5px] border-t border-l"
          }`}
        />
      )}

      <div className="card-body gap-0 px-3.5 py-2.5">
        <div className="overflow-y-auto break-words pr-0.5" style={bodyStyle}>
          {renderNodes(
            footnote.nodes,
            { prefs, effectiveTheme, onNavigateInternal, onOpenExternal },
            "fn",
          )}
        </div>

        {showFooter && (
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-base-content/10 pt-1.5 text-[11px]">
            <span className="min-w-0 truncate opacity-55">{showLabel ? footnote.label : ""}</span>
            {canJump && (
              <button
                type="button"
                className="btn btn-ghost btn-xs h-auto min-h-0 shrink-0 px-1.5 py-0.5 text-[11px] font-normal text-primary/80 hover:text-primary"
                onClick={onJumpToTarget}
              >
                跳转到注释处
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
