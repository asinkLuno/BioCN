/**
 * Turns a chapter document from the EPUB parser into renderable HTML.
 *
 * The parser hands back a Document whose resources are blob: URLs; we need a
 * self-contained string for an `<iframe srcdoc>` (srcdoc iframes inherit the
 * CSP and need no frame-src dance, and blobs from the parser's cache die with
 * the book — a srcdoc snapshot cannot dangle).
 *
 * Everything below is structural glue, not presentation: the book's own CSS
 * keeps styling the content, we only add a base stylesheet (reader typography
 * + our svo colors) and the overlay's coloring spans.
 */
import { paintChapter, BOOK_STYLESHEET } from "./overlay";
import type { ColoredParagraph } from "./reading";

/** Base styles appended after the book's own styles. */
const READER_STYLESHEET = `
:root { color-scheme: light dark; }
body {
  margin: 0 auto;
  padding: 1rem 1.25rem 50vh;
  max-width: 42rem;
  font-size: 1.0625rem;
  line-height: 1.9;
  overflow-wrap: break-word;
}
img, svg, video { max-width: 100%; height: auto; }
${BOOK_STYLESHEET}
`;

/** Serializes a section document into an srcdoc string, colored in place. */
export function renderSection(
  doc: Document,
  paragraphs: ColoredParagraph[],
): string {
  const stats = paintChapter(doc, paragraphs);
  if (stats.skipped > 0) {
    // Coloring is best-effort: an unmatched paragraph stays uncolored, the
    // page itself must never fail for it.
    console.warn(`epub: ${stats.skipped} 段未着色（文本不匹配）`);
  }

  // The book's <style>/links stay; our base sheet goes last so reader
  // typography wins ties but book-specific rules still apply.
  const style = doc.createElement("style");
  style.textContent = READER_STYLESHEET;
  doc.head?.appendChild(style);

  const html = doc.documentElement?.outerHTML ?? "";
  return "<!DOCTYPE html>" + html;
}
