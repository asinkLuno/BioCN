/**
 * The seam between BioCN and foliate-js.
 *
 * foliate-js warns that its API may break at any time, so every call into it
 * goes through this module: a version bump only ever touches one file. What
 * the reader needs is deliberately narrow — open a Blob, render sections in
 * scroll flow, report section loads and relocations, navigate by spine index.
 *
 * Importing the module registers the `foliate-view` custom element; the
 * element is then created with `createElement`, which jsdom tests can stub at
 * this module's boundary without loading the real library.
 */
import "foliate-js/view.js";

import { convertFileSrc } from "@tauri-apps/api/core";

// `FoliateView`, `FoliateLoadDetail`, `FoliateRelocateDetail`, `FoliateBook`
// and `FoliateTocItem` are ambient globals from `src/types/foliate-js.d.ts`.

/**
 * Reads the stored EPUB through the asset protocol and hands it to foliate.
 *
 * The bytes must not cross the IPC bridge (a whole book freezes the app);
 * the asset protocol streams the file from disk instead, and its scope in
 * `tauri.conf.json` covers exactly the library's files directory.
 */
export async function fetchBookBlob(filePath: string): Promise<File> {
  const response = await fetch(convertFileSrc(filePath));
  if (!response.ok) throw new Error(`无法读取书文件（${response.status}）`);
  const blob = await response.blob();
  // foliate's format sniffing reads `file.name` — its zip branch asks
  // `isCBZ`/`isFBZ`, which destructure `{ name, type }` and call
  // `name.endsWith(...)`. A bare Blob has no name and crashes the open with
  // "undefined is not an object". A File named `*.epub` steers every check
  // to the EPUB branch, which decides by zip magic bytes anyway — the name
  // only ever rules the comic-book and FB2 zip formats out.
  return new File([blob], "book.epub", { type: "application/epub+zip" });
}

/**
 * Creates the view element and opens `blob` in scroll flow.
 *
 * `flow` must be set before the first render: the paginator reads it as an
 * attribute and defaults to paginated without it. Navigation is left to the
 * caller — `open()` renders nothing yet, so the reader can land on its first
 * chapter with prose without loading section 0 first.
 */
export async function createBookView(
  blob: Blob,
  handlers: {
    onLoad: (detail: FoliateLoadDetail) => void;
    onRelocate: (detail: FoliateRelocateDetail) => void;
  },
): Promise<FoliateView> {
  const view = document.createElement("foliate-view");
  view.addEventListener("load", (event) => handlers.onLoad(event.detail));
  view.addEventListener("relocate", (event) => handlers.onRelocate(event.detail));
  await view.open(blob);
  view.renderer.setAttribute("flow", "scrolled");
  return view;
}

/** One flat TOC entry, resolved to the spine index its link opens. */
export interface TocEntry {
  label: string;
  index: number;
  depth: number;
}

/**
 * Flattens the book's own table of contents into menu rows.
 *
 * Hrefs that do not resolve to a spine section (broken links, fragments of
 * unlisted documents) are dropped rather than shown dead. `depth` preserves
 * the nesting for an indented menu; foliate gives `resolveHref`'s index as
 * the spine position, the same numbering the Rust reader's chapters use.
 */
export function flattenToc(book: FoliateBook): TocEntry[] {
  const out: TocEntry[] = [];
  const walk = (items: FoliateTocItem[], depth: number) => {
    for (const item of items) {
      const label = item.label?.trim();
      if (!label) continue;
      let index: number | null = null;
      try {
        index = book.resolveHref(item.href)?.index ?? null;
      } catch {
        // A broken TOC link must not break the menu.
      }
      if (index === null || index < 0) continue;
      out.push({ label, index, depth });
      if (item.subitems?.length) walk(item.subitems, depth + 1);
    }
  };
  walk(book.toc ?? [], 0);
  return out;
}
