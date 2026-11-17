/**
 * Typed bridge to the Rust `export` module.
 *
 * The shapes mirror `src-tauri/src/export.rs` field for field.
 */
import { invoke } from "@tauri-apps/api/core";

/** Where the colors live in the exported book. */
export type Stylesheet = "inline" | "external";

/**
 * What the export did, for a message that says so.
 *
 * `skipped` is the honest part: exporting a half-colored book is allowed, and
 * the reader who gets that file should be told which chapters are plain rather
 * than finding out by opening them.
 */
export interface ExportReport {
  /** Chapters whose spans were written, and chapters in the book. */
  colored: number;
  chapters: number;
  /** Chapters with no analysis yet, copied unchanged. */
  skipped: number;
}

/**
 * Writes a colored copy of `id` to `path`.
 *
 * `path` may be a filesystem path or the `content://` URI Android's save dialog
 * returns; the backend decides how to open it.
 */
export const exportBook = (id: string, path: string, stylesheet: Stylesheet) =>
  invoke<ExportReport>("export_book", { id, path, stylesheet });

/**
 * A book title as a file name: `《三体》/黑暗森林` is a path, not a name.
 *
 * Windows refuses `\ / : * ? " < > |`, Android's document provider dislikes a
 * leading `.`, and a trailing space or dot silently disappears on save — so all
 * of them are folded into `_` rather than left to fail at the last moment.
 */
export function fileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 80);
  // Nothing left that names anything: a file called `___.epub` is worse than
  // one called `book.epub`.
  return `${/\p{L}|\p{N}/u.test(cleaned) ? cleaned : "book"}.epub`;
}

/**
 * The name of a file that was just written, for a message that says where.
 *
 * Android's save dialog answers with a percent-encoded `content://` URI whose
 * last segment is the whole document path (`primary%3ABooks%2FDune.epub`), so a
 * plain `split("/")` would report a name nobody recognises. Mirrors
 * `display_name` in `src-tauri/src/library/mod.rs`.
 */
export function fileNameOf(path: string): string {
  const trimmed = path.split(/[?#]/)[0].replace(/\/+$/, "");
  const last = trimmed.split(/[/\\]/).pop() ?? trimmed;
  if (!path.includes("://")) return last;
  try {
    // Decoding can reveal separators, so take a segment again afterwards.
    const decoded = decodeURIComponent(last);
    return decoded.split(/[/\\]/).pop() || last;
  } catch {
    // A lone `%` is not an escape: the raw segment is the better answer.
    return last;
  }
}
