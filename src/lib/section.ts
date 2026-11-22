/**
 * Turns a chapter document from the EPUB parser into renderable HTML.
 *
 * The parser hands back a Document whose resources are blob: URLs; we need a
 * self-contained string for an `<iframe srcdoc>` (srcdoc iframes inherit the
 * CSP and need no frame-src dance, and blobs from the parser's cache die with
 * the book — a srcdoc snapshot cannot dangle).
 *
 * Coloring is not done here: the parser's document already carries the
 * `<span class="svo-*">` the Rust side spliced in (see `src-tauri/src/export.rs`
 * `colorize`), so everything below is structural glue — the book's own CSS
 * keeps styling the content, we only add a base stylesheet (reader typography
 * and the svo colors for books that do not ship them).
 */

/**
 * The stylesheet injected into every section document.
 *
 * The six token colors are copied verbatim by `src-tauri/src/export.rs`
 * (`STYLESHEET`) and mirrored by `src/index.css` (`.svo-*`) — change all three
 * together. Light mode keeps the book's own colors and background; dark mode
 * follows the app theme instead, or a black-on-dark book would be unreadable.
 *
 * The measure is capped at 48rem so a line stays readable in a maximized
 * desktop window, and it matches the app chrome's `max-w-3xl`.
 */
export const BOOK_STYLESHEET = `
.svo-subject { color: #d95f02; }
.svo-predicate { color: #1b9e77; }
.svo-object { color: #7570b3; }
@media (prefers-color-scheme: dark) {
  html, body { background-color: #1e1e1e !important; color: #d4d4d4 !important; }
  .svo-subject { color: #f28e4b; }
  .svo-predicate { color: #4ec6a3; }
  .svo-object { color: #a99cf0; }
}
`;

/** Base styles appended after the book's own styles. */
const READER_STYLESHEET = `
:root { color-scheme: light dark; }
body {
  /* border-box so the 48rem measure is the whole column and lines up with the
     app chrome's max-w-3xl (an iframe document gets no reset of its own). */
  box-sizing: border-box;
  margin: 0 auto;
  max-width: 48rem;
  padding: 1.25rem 2rem 4rem;
  font-size: 1.0625rem;
  line-height: 1.9;
  overflow-wrap: break-word;
}
img, svg, video { max-width: 100%; height: auto; }
${BOOK_STYLESHEET}
`;

/** Serializes a section document into an srcdoc string. */
export function renderSection(doc: Document): string {
  // The book's <style>/links stay; our base sheet goes last so reader
  // typography wins ties but book-specific rules still apply.
  const style = doc.createElement("style");
  style.textContent = READER_STYLESHEET;
  doc.head?.appendChild(style);

  const html = doc.documentElement?.outerHTML ?? "";
  return "<!DOCTYPE html>" + html;
}
