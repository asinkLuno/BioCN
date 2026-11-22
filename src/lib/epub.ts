/**
 * EPUB data layer: foliate-js used ONLY as a parser, never as a renderer.
 *
 * The previous attempt (branch `foliate-attempt`) handed rendering to
 * `foliate-view`, whose paginator lives in a closed shadow root: scrolling,
 * measurement and relocate events all happen inside a blob: iframe we can
 * neither reach nor fix, which is why the reader could not scroll, showed a
 * clipped page and had a dead next-chapter button.
 *
 * This module takes the parser and nothing else: `makeBook()` reads the zip,
 * resolves the spine/TOC/resources, and `loadSection()` gives us the chapter
 * document with its images and CSS already rewritten to blob: URLs. We render
 * that document ourselves — scrolling, chapter navigation and coloring stay in
 * our own components.
 */
import { makeBook } from "foliate-js/view.js";
import { EPUB } from "foliate-js/epub.js";

import { convertFileSrc } from "@tauri-apps/api/core";

type FoliateBook = import("foliate-js/view.js").FoliateBook;

export async function openBook(blob: Blob): Promise<FoliateBook> {
  const book = await makeBook(toNamedFile(blob));
  return book;
}

/** A book whose chapter documents come from Rust already colored. */
export interface ColoredBook {
  book: FoliateBook;
  /**
   * Serves `html` for the chapter at `href` (a section `id`, i.e. the manifest
   * href) on its next `load()`. Chapters never change content, so a section
   * already loaded keeps its cached copy.
   */
  put(href: string, html: string): void;
}

/**
 * The same book, with colored chapter documents.
 *
 * Coloring happens in Rust, at the byte offsets of the chapter's own XHTML, so
 * the document reaching the iframe already carries its `<span class="svo-*">`.
 * The catch: foliate's loader is what rewrites images and CSS to blob: URLs,
 * and it reads the raw zip entry itself — so the colored document has to be
 * what the loader reads. `makeBook()` keeps its loader private, but exposes the
 * zip reads, so a second `EPUB` over the same zip with a wrapped `loadText` is
 * a book with the parser's resource rewriting and our coloring in one pass.
 *
 * `put()` before each chapter's `load()`; the wrap does not touch anything else
 * (container, OPF, TOC and stylesheets still come from the zip).
 */
export async function openColoredBook(blob: Blob): Promise<ColoredBook> {
  const source = await openBook(blob);
  const colored = new Map<string, string>();
  const book = await new EPUB({
    loadText: async (uri: string) => colored.get(uri) ?? source.loadText(uri),
    loadBlob: (uri: string) => source.loadBlob(uri),
    getSize: (uri: string) => source.getSize(uri),
  }).init();
  return { book, put: (href, html) => colored.set(href, html) };
}

export interface TocDestination {
  index: number;
  anchor: string | null;
}

export function resolveTocHref(
  book: import("foliate-js/view.js").FoliateBook,
  href: string,
  chapters: readonly { index: number; manifestId: string }[],
): TocDestination | null {
  if (book.isExternal(href)) return null;
  // Foliate returns the original spine index (not an index into filtered sections).
  let resolved;
  try { resolved = book.resolveHref(href); } catch { return null; }
  const chapter = chapters.find((entry) => entry.index === resolved?.index);
  if (!chapter) return null;
  const anchor = href.split("#").slice(1).join("#");
  return { index: chapter.index, anchor: anchor || null };
}

export function sectionForChapter(book: import("foliate-js/view.js").FoliateBook, manifestId: string) {
  const href = book.resources.getItemByID(manifestId)?.href;
  return book.sections.find((section) => section.id === href);
}
/**
 * Reads the stored EPUB through the asset protocol.
 *
 * The bytes must not cross the IPC bridge (a whole book freezes the app); the
 * asset protocol streams the file from disk. Its scope in `tauri.conf.json`
 * covers exactly the library's files directory.
 */
async function readBookFile(filePath: string): Promise<Blob> {
  const response = await fetch(convertFileSrc(filePath));
  if (!response.ok) throw new Error(`无法读取书文件（${response.status}）`);
  return response.blob();
}

export function fetchBookBlob(filePath: string): Promise<File> {
  return readBookFile(filePath).then(toNamedFile);
}

function toNamedFile(blob: Blob): File {
  // foliate's zip branch reads `file.name` (isCBZ/isFBZ call `name.endsWith`);
  // a bare Blob crashes there. The name only steers format detection.
  return new File([blob], "book.epub", { type: "application/epub+zip" });
}
