/**
 * Painting 主谓宾 colors onto foliate-rendered documents.
 *
 * The analyzer works on the paragraph text that `src-tauri/src/reader/mod.rs`
 * extracts from the same XHTML the renderer shows: markup flattened, entities
 * resolved, whitespace collapsed, with UTF-16 offsets into that text. The
 * renderer's DOM carries the *original* markup, so the offsets cannot be used
 * directly — this module re-derives the parser's paragraph list from the live
 * document, matches it against the analyzer's, and turns the offsets into
 * wrapped spans.
 *
 * The rules below mirror the Rust parser element for element (frames, skips,
 * `<br>` spaces, whitespace collapse), and every match is gated on string
 * equality: a paragraph that cannot be matched is left uncolored rather than
 * colored from a guess. Worst case is a missing color, never a wrong one.
 */
import type { ColoredParagraph, Role } from "./reading";

/** Elements whose text is not prose — mirrors the parser's `SKIPPED`. */
const SKIPPED = new Set(["script", "style", "rt", "rp", "svg", "math"]);

/** Elements that are one paragraph on their own — mirrors `PARAGRAPHS`. */
const PARAGRAPH_ELEMENTS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "dt",
  "dd",
  "td",
  "th",
  "pre",
  "figcaption",
  "caption",
]);

/** Elements that group content — mirrors `CONTAINERS`. */
const CONTAINER_ELEMENTS = new Set([
  "div",
  "section",
  "article",
  "blockquote",
  "ul",
  "ol",
  "dl",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "figure",
  "header",
  "footer",
  "aside",
  "nav",
  "main",
  "body",
  "html",
]);

/**
 * Unicode White_Space, the set Rust's `char::is_whitespace` answers true for.
 *
 * A hand-rolled class rather than `\s`: JavaScript's `\s` also eats U+FEFF,
 * which Rust keeps as a regular character, and one mismatched character is
 * enough for the equality gate to reject a whole paragraph.
 */
const WHITE_SPACE =
  /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;

/** One raw character of a paragraph, and where it lives in the document. */
interface SourceChar {
  /** `null` for a character not in the markup at all — the space a `<br>` becomes. */
  node: Text | null;
  /** UTF-16 offset of the character within `node.data`. */
  index: number;
}

/** The raw characters one parser frame collected, before collapsing. */
type Frame = SourceChar[];

/**
 * Where one character of the collapsed paragraph text came from.
 *
 * The collapsed space a whitespace run becomes is charged to the character
 * that follows it, exactly like the Rust parser charges it to the following
 * character's markup bytes: a span boundary must not fall between the space
 * and the word it precedes. A supplementary character (a surrogate pair) is
 * one position spanning both of its UTF-16 units.
 */
interface DOMPoint {
  node: Text;
  /** UTF-16 offset of the character within `node.data`. */
  index: number;
  /** UTF-16 length of the character: 2 across a surrogate pair, else 1. */
  len: number;
}

export interface CollapsedParagraph {
  /** The analyzer's view of the paragraph: what the offsets index into. */
  text: string;
  /** One entry per UTF-16 code unit of `text`; `null` for a collapsed space. */
  points: (DOMPoint | null)[];
}

function isFrame(name: string): boolean {
  return PARAGRAPH_ELEMENTS.has(name) || CONTAINER_ELEMENTS.has(name);
}

/**
 * The parser's paragraph list, re-derived from a rendered document.
 *
 * Walks from `documentElement` rather than `body` because the Rust parser
 * walks the whole document: text inside `<head>` (a document `<title>`) is
 * collected by the open `<html>` frame and flushed when `<body>` opens, so it
 * is paragraph zero of every chapter — the analyzer's list starts with it,
 * and the match below depends on this side producing it too.
 *
 * Like the parser, a frame is collapsed when its text is flushed — at a child
 * block, or at the frame's end — and an empty (whitespace-only) flush emits
 * nothing: `push_paragraph` on the Rust side.
 */
export function enumerateParagraphs(root: Element): CollapsedParagraph[] {
  const out: CollapsedParagraph[] = [];
  // Open frames, innermost last. Text lands in the innermost frame, so a
  // `<p>` inside a `<div>` collects its own text and the `<div>` keeps only
  // what sits outside the `<p>`.
  const stack: Frame[] = [];

  // Ends the text before a child block (or at a frame's end) and keeps the
  // frame open for what follows — `Frame::flush_text` on the Rust side.
  const flush = () => {
    const top = stack[stack.length - 1];
    if (!top) return;
    stack[stack.length - 1] = [];
    const collapsed = collapseParagraph(top);
    if (collapsed.text.length > 0) out.push(collapsed);
  };

  const visit = (node: Node): void => {
    // CDATA sections count as text (they subclass `Text`); the Rust parser
    // takes their characters too.
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
      if (stack.length === 0) return;
      const text = node as Text;
      const data = text.data;
      const top = stack[stack.length - 1];
      let at = 0;
      while (at < data.length) {
        top.push({ node: text, index: at });
        at += codePointLength(data, at);
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const name = el.localName.toLowerCase();
    if (SKIPPED.has(name)) return;
    if (isFrame(name)) {
      // A child block ends the text before it: `<div>见<p>字</p>后</div>`
      // is "见", "字", "后". The parent frame stays open, so the text after
      // the child still belongs to it — that is what keeps the paragraphs
      // in reading order.
      flush();
      stack.push([]);
      for (const child of Array.from(el.childNodes)) visit(child);
      flush();
      stack.pop();
      return;
    }
    // `<br/>` ends the current line but not the paragraph: it becomes a
    // space that is in the text but not in the markup.
    if (name === "br" && stack.length > 0) {
      stack[stack.length - 1].push({ node: null, index: 0 });
      return;
    }
    // Inline markup is transparent: its characters belong to the frame.
    for (const child of Array.from(el.childNodes)) visit(child);
  };

  visit(root);
  // A DOM cannot end mid-frame, but closing the rest costs nothing and keeps
  // the shape identical to the parser's tail loop.
  while (stack.length > 0) {
    flush();
    stack.pop();
  }
  return out;
}

/** UTF-16 length of the code point at `at`: 2 across a surrogate pair. */
function codePointLength(data: string, at: number): number {
  const unit = data.charCodeAt(at);
  return unit >= 0xd800 && unit <= 0xdbff && at + 1 < data.length ? 2 : 1;
}

/**
 * Collapses one frame's characters into its text, keeping DOM positions.
 *
 * Runs of whitespace collapse to one space, which is what the analyzer was
 * given; the surviving characters keep where they came from, so the offsets
 * can be turned into positions inside the rendered paragraph.
 */
export function collapseParagraph(chars: SourceChar[]): CollapsedParagraph {
  let text = "";
  const points: (DOMPoint | null)[] = [];
  // Whitespace seen but not yet emitted: one run may end in spaces and the
  // next begin immediately, and the collapse owes exactly one space between.
  let pendingSpace = false;
  for (const ch of chars) {
    const value = ch.node === null ? " " : charAt(ch.node.data, ch.index);
    if (value !== null && WHITE_SPACE.test(value)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && text.length > 0) {
      // The space is charged to this character, keeping the two together.
      text += " ";
      points.push(pointOf(ch));
    }
    pendingSpace = false;
    text += value;
    points.push(pointOf(ch));
    // A supplementary character occupies two UTF-16 units: the low half maps
    // to the same position, keeping `points` aligned with string indices.
    if (value !== null && value.length === 2) points.push(pointOf(ch));
  }
  // A trailing whitespace run is dropped, the way the parser drops it.
  return { text, points };
}

/** The character at a UTF-16 offset, or `null` past the end. */
function charAt(data: string, at: number): string | null {
  if (at >= data.length) return null;
  return data.slice(at, at + codePointLength(data, at));
}

function pointOf(ch: SourceChar): DOMPoint {
  // `node` is only null for the `<br>` space, which never reaches here: it is
  // whitespace, so it becomes a pending space charged to the character after it.
  const len = ch.node === null ? 1 : codePointLength(ch.node.data, ch.index);
  return { node: ch.node as Text, index: ch.index, len };
}

/** How many analyzer paragraphs to look ahead when the sequences drift apart. */
const LOOKAHEAD = 2;

export interface PaintStats {
  /** Paragraphs that got at least one colored span. */
  painted: number;
  /** Paragraphs whose text did not match the analyzer's — left uncolored. */
  skipped: number;
}

/**
 * Colors every paragraph of a rendered section document that the analyzer
 * colored.
 *
 * The renderer and the parser read the same spine document, so the paragraph
 * lists line up in order; a repair the DOM made that the lenient XML parser
 * did not can still drop or duplicate one, which is what the small look-ahead
 * absorbs. Returns counts so a systematic drift is visible in diagnostics.
 */
export function paintChapter(doc: Document, paragraphs: ColoredParagraph[]): PaintStats {
  const root = doc.documentElement;
  if (!root) return { painted: 0, skipped: 0 };
  let painted = 0;
  let skipped = 0;
  let cursor = 0;
  for (const { text, points } of enumerateParagraphs(root)) {
    let at = -1;
    for (let ahead = 0; ahead <= LOOKAHEAD && cursor + ahead < paragraphs.length; ahead++) {
      if (paragraphs[cursor + ahead].text === text) {
        at = cursor + ahead;
        break;
      }
    }
    if (at < 0) {
      skipped++;
      continue;
    }
    cursor = at + 1;
    if (paintParagraph(doc, text, points, paragraphs[at])) painted++;
  }
  return { painted, skipped };
}

/** One contiguous stretch of one text node that a span must cover. */
interface NodeSpan {
  node: Text;
  from: number;
  /** Exclusive: the offset just past the last covered character. */
  to: number;
}

/**
 * The spans of a sentence segment, in document order.
 *
 * The points between `start` and `end` are the segment's characters in
 * reading order, so grouping them per node yields the exact stretches to
 * wrap — no `Range` and no tree walk needed.
 */
function collectSpans(points: (DOMPoint | null)[], start: number, end: number): NodeSpan[] {
  const byNode = new Map<Text, NodeSpan>();
  for (let i = start; i < end && i < points.length; i++) {
    const point = points[i];
    if (!point) continue;
    const existing = byNode.get(point.node);
    if (existing) existing.to = point.index + point.len;
    else byNode.set(point.node, { node: point.node, from: point.index, to: point.index + point.len });
  }
  return Array.from(byNode.values());
}

function paintParagraph(
  doc: Document,
  text: string,
  points: (DOMPoint | null)[],
  paragraph: ColoredParagraph,
): boolean {
  const spans: (NodeSpan & { role: Role })[] = [];
  for (const sentence of paragraph.sentences) {
    // The sentence text is the authority, the offsets only say where it sits:
    // an analyzer whose offsets do not line up must not paint wrong characters.
    if (text.slice(sentence.start, sentence.start + sentence.text.length) !== sentence.text) {
      continue;
    }
    for (const segment of sentence.segments) {
      if (segment.role === "normal") continue;
      if (sentence.text.slice(segment.start, segment.start + segment.text.length) !== segment.text) {
        continue;
      }
      const start = sentence.start + segment.start;
      for (const span of collectSpans(points, start, start + segment.text.length)) {
        spans.push({ ...span, role: segment.role });
      }
    }
  }
  // Apply from the end backwards: splitting a node for a later span must not
  // invalidate the offsets an earlier span still holds.
  for (const { node, from, to, role } of spans.reverse()) {
    wrapSpan(doc, node, from, to, role);
  }
  return spans.length > 0;
}

/** Splits `node` at the span's ends and wraps the middle in a role span. */
function wrapSpan(doc: Document, node: Text, from: number, to: number, role: Role): void {
  if (to <= from || from >= node.data.length) return;
  // Split the tail first so the start offset stays meaningful.
  if (to < node.data.length) node.splitText(to);
  const middle = from > 0 ? node.splitText(from) : node;
  const span = doc.createElement("span");
  span.className = `svo svo-${role}`;
  middle.parentNode?.insertBefore(span, middle);
  span.appendChild(middle);
}

/**
 * The stylesheet injected into every section document.
 *
 * The six token colors are copied verbatim by `src-tauri/src/export.rs`
 * (`STYLESHEET`) and mirrored by `src/index.css` (`.svo-*`) — change all
 * three together. Light mode keeps the book's own colors and background;
 * dark mode follows the app theme instead, or a black-on-dark book would be
 * unreadable — `--theme-bg-color` is what foliate's paginator paints the
 * frame background with.
 */
export const BOOK_STYLESHEET = `
.svo-subject { color: #d95f02; }
.svo-predicate { color: #1b9e77; }
.svo-object { color: #7570b3; }
@media (prefers-color-scheme: dark) {
  :root { --theme-bg-color: #1e1e1e; }
  html, body { color: #d4d4d4 !important; }
  .svo-subject { color: #f28e4b; }
  .svo-predicate { color: #4ec6a3; }
  .svo-object { color: #a99cf0; }
}
`;
