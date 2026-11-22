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

import { convertFileSrc } from "@tauri-apps/api/core";

export async function openBook(
  blob: Blob,
): Promise<import("foliate-js/view.js").FoliateBook> {
  const book = await makeBook(toNamedFile(blob));
  return book;
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
