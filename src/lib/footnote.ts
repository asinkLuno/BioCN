/**
 * Safe EPUB footnote parsing and URL classification.
 *
 * Footnote HTML originates from untrusted EPUB chapter documents and is
 * rendered inside the host Tauri webview (which holds IPC privileges). Rather
 * than ever using `dangerouslySetInnerHTML`, we parse into a strict allowlisted
 * AST rendered as pure React elements.
 */
import { bookResourceUrl, resolveRelativeHref } from "./bookProtocol";
import type { ChapterSummary, TocEntry } from "./reading";

export type SvoRole = "subject" | "predicate" | "object";

export type AllowedElementTag =
  | "p"
  | "div"
  | "blockquote"
  | "ul"
  | "ol"
  | "li"
  | "dl"
  | "dt"
  | "dd"
  | "pre"
  | "figure"
  | "figcaption"
  | "table"
  | "thead"
  | "tbody"
  | "tfoot"
  | "tr"
  | "th"
  | "td"
  | "span"
  | "em"
  | "i"
  | "strong"
  | "b"
  | "u"
  | "s"
  | "del"
  | "ins"
  | "sub"
  | "sup"
  | "small"
  | "mark"
  | "code"
  | "kbd"
  | "samp"
  | "cite"
  | "q"
  | "abbr"
  | "ruby"
  | "rt"
  | "rp"
  | "bdi"
  | "bdo";

export type FootnoteNode =
  | { kind: "text"; text: string }
  | { kind: "br" }
  | { kind: "hr" }
  | { kind: "img"; src: string; alt: string }
  | {
      kind: "link";
      linkType: "external";
      href: string;
      title?: string;
      children: FootnoteNode[];
    }
  | {
      kind: "link";
      linkType: "internal";
      path: string;
      anchor: string | null;
      title?: string;
      children: FootnoteNode[];
    }
  | { kind: "svo"; role: SvoRole; children: FootnoteNode[] }
  | {
      kind: "element";
      tag: AllowedElementTag;
      title?: string;
      colSpan?: number;
      rowSpan?: number;
      children: FootnoteNode[];
    };

export interface FootnoteParseContext {
  bookId: string;
  /** Container path of the document that owns the footnote HTML (e.g. `OEBPS/Text/notes.xhtml`). */
  baseHref: string;
}

const FORBIDDEN_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "link",
  "meta",
  "base",
  "noscript",
  "svg",
  "math",
  "audio",
  "video",
  "canvas",
  "template",
]);

const ALLOWED_TAGS = new Set<AllowedElementTag>([
  "p",
  "div",
  "blockquote",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "pre",
  "figure",
  "figcaption",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "span",
  "em",
  "i",
  "strong",
  "b",
  "u",
  "s",
  "del",
  "ins",
  "sub",
  "sup",
  "small",
  "mark",
  "code",
  "kbd",
  "samp",
  "cite",
  "q",
  "abbr",
  "ruby",
  "rt",
  "rp",
  "bdi",
  "bdo",
]);

const EXTERNAL_HREF_RE = /^(https?:|mailto:|tel:)/i;
const ANY_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_BOOK_URL_RE = /^(?:book:\/\/|https?:\/\/book\.localhost\/)/i;
const SAFE_DATA_IMG_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i;

const FOOTNOTE_ANCHOR_RE = /^(?:fn|ftn|footnote|endnote|rearnote|note|zhushi|zhu)[-_:.]?\d/i;
const FOOTNOTE_PATH_RE = /(?:^|\/|_|-)(?:footnotes?|endnotes?|notes?|zhushi)(?:[._-]|$)/i;

/**
 * Heuristic for plain cross-chapter links (without `epub:type="noteref"` or
 * `<sup>`) whose target path or fragment looks like an endnote.
 */
export function looksLikeFootnoteHref(path: string, anchor: string | null): boolean {
  if (!anchor) return false;
  return FOOTNOTE_ANCHOR_RE.test(anchor) || FOOTNOTE_PATH_RE.test(path);
}

/**
 * Collects all `chapterHref#anchor` targets referenced by the book's TOC so
 * section cross-references are never mistaken for footnotes.
 */
export function collectTocAnchors(toc: TocEntry[], chapters: ChapterSummary[]): Set<string> {
  const byIndex = new Map<number, string>();
  for (const ch of chapters) {
    byIndex.set(ch.index, ch.href);
  }
  const anchors = new Set<string>();
  const walk = (items: TocEntry[]) => {
    for (const item of items) {
      if (item.anchor && item.chapterIndex !== null) {
        const href = byIndex.get(item.chapterIndex);
        if (href) anchors.add(`${href}#${item.anchor}`);
      }
      if (item.subitems.length > 0) walk(item.subitems);
    }
  };
  walk(toc);
  return anchors;
}

function resolveSafeImgSrc(rawSrc: string, ctx: FootnoteParseContext): string | null {
  const trimmed = rawSrc.trim();
  if (!trimmed) return null;
  if (SAFE_BOOK_URL_RE.test(trimmed) || SAFE_DATA_IMG_RE.test(trimmed)) {
    return trimmed;
  }
  if (ANY_SCHEME_RE.test(trimmed) || trimmed.startsWith("//")) {
    return null;
  }
  const resolved = resolveRelativeHref(ctx.baseHref, trimmed);
  if (!resolved) return null;
  return bookResourceUrl(ctx.bookId, resolved.path);
}

function extractSvoRole(el: Element): SvoRole | null {
  const cls = el.getAttribute("class");
  if (!cls) return null;
  const tokens = cls.trim().split(/\s+/);
  if (tokens.includes("svo-subject")) return "subject";
  if (tokens.includes("svo-predicate")) return "predicate";
  if (tokens.includes("svo-object")) return "object";
  return null;
}

function parseSpanCount(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 && n <= 20 ? n : undefined;
}

function convertDomNode(node: Node, ctx: FootnoteParseContext, depth: number): FootnoteNode[] {
  if (depth > 32) return [];

  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue ?? "";
    return text ? [{ kind: "text", text }] : [];
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return [];
  }

  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  if (FORBIDDEN_TAGS.has(tag)) {
    return [];
  }

  if (tag === "br") return [{ kind: "br" }];
  if (tag === "hr") return [{ kind: "hr" }];

  if (tag === "img") {
    const src = resolveSafeImgSrc(el.getAttribute("src") ?? "", ctx);
    if (!src) return [];
    return [{ kind: "img", src, alt: el.getAttribute("alt") ?? "" }];
  }

  const children: FootnoteNode[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    children.push(...convertDomNode(el.childNodes[i], ctx, depth + 1));
  }

  if (tag === "a") {
    const rawHref = (el.getAttribute("href") ?? "").trim();
    const title = el.getAttribute("title") ?? undefined;
    if (!rawHref) {
      return children;
    }
    if (EXTERNAL_HREF_RE.test(rawHref)) {
      return [{ kind: "link", linkType: "external", href: rawHref, title, children }];
    }
    if (ANY_SCHEME_RE.test(rawHref) || rawHref.startsWith("//")) {
      // Disallow javascript:, data:, file:, etc. — keep visible text only.
      return children;
    }
    const resolved = resolveRelativeHref(ctx.baseHref, rawHref);
    if (!resolved) {
      return children;
    }
    return [
      {
        kind: "link",
        linkType: "internal",
        path: resolved.path,
        anchor: resolved.anchor,
        title,
        children,
      },
    ];
  }

  if (tag === "span") {
    // Strip zero-width BioCN paragraph anchors (`<span data-bp="0"></span>`).
    if (el.hasAttribute("data-bp") && children.length === 0) {
      return [];
    }
    const svoRole = extractSvoRole(el);
    if (svoRole) {
      return children.length > 0 ? [{ kind: "svo", role: svoRole, children }] : [];
    }
    return children.length > 0 ? [{ kind: "element", tag: "span", children }] : [];
  }

  if (ALLOWED_TAGS.has(tag as AllowedElementTag)) {
    const allowedTag = tag as AllowedElementTag;
    const title = allowedTag === "abbr" ? (el.getAttribute("title") ?? undefined) : undefined;
    const colSpan =
      allowedTag === "th" || allowedTag === "td"
        ? parseSpanCount(el.getAttribute("colspan"))
        : undefined;
    const rowSpan =
      allowedTag === "th" || allowedTag === "td"
        ? parseSpanCount(el.getAttribute("rowspan"))
        : undefined;
    return [
      {
        kind: "element",
        tag: allowedTag,
        ...(title ? { title } : {}),
        ...(colSpan ? { colSpan } : {}),
        ...(rowSpan ? { rowSpan } : {}),
        children,
      },
    ];
  }

  // Unknown benign wrapper tag (e.g. `<aside>`, `<section>`, `<font>`): flatten safely.
  return children;
}

/**
 * Parses extracted footnote HTML into a sanitized AST safe to render in React.
 */
export function parseFootnoteHtml(html: string, ctx: FootnoteParseContext): FootnoteNode[] {
  if (!html || typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc.body) return [];

  const nodes: FootnoteNode[] = [];
  for (let i = 0; i < doc.body.childNodes.length; i++) {
    nodes.push(...convertDomNode(doc.body.childNodes[i], ctx, 0));
  }

  // Trim leading/trailing pure-whitespace text nodes.
  while (nodes.length > 0) {
    const first = nodes[0];
    if (first.kind === "text" && first.text.trim() === "") nodes.shift();
    else break;
  }
  while (nodes.length > 0) {
    const last = nodes[nodes.length - 1];
    if (last.kind === "text" && last.text.trim() === "") nodes.pop();
    else break;
  }
  return nodes;
}

export function hasVisibleFootnoteContent(nodes: FootnoteNode[]): boolean {
  for (const node of nodes) {
    if (node.kind === "text" && node.text.trim().length > 0) return true;
    if (node.kind === "img") return true;
    if (
      (node.kind === "element" || node.kind === "link" || node.kind === "svo") &&
      hasVisibleFootnoteContent(node.children)
    ) {
      return true;
    }
  }
  return false;
}
