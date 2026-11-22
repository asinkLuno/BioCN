/**
 * Typed bridge to the Rust `reading`, `progress`, and `analyzer` modules.
 *
 * Chapters and resources are served directly from Rust over the `book://`
 * custom protocol (zero frontend zip parsing or blob: URL rewriting). IPC here
 * carries only lightweight metadata, reading progress, and progressive coloring
 * commands/events.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface TocEntry {
  label: string;
  chapterIndex: number | null;
  anchor: string | null;
  subitems: TocEntry[];
}

export interface ChapterSummary {
  index: number;
  manifestId: string;
  /** Container path inside the EPUB (no leading `/`), e.g. `OEBPS/Text/ch1.xhtml`. */
  href: string;
  title: string | null;
  /** Whether this chapter is already fully colored under the active model weights. */
  colored: boolean;
}

export interface ReadingProgress {
  chapterIndex: number;
  paragraphIndex: number | null;
  ratio: number;
  updatedAt: number;
}

export interface BookView {
  id: string;
  title: string;
  chapters: ChapterSummary[];
  toc: TocEntry[];
  /** Saved progress chapter if valid, otherwise the first chapter with prose. */
  initialChapter: number | null;
  progress: ReadingProgress | null;
  hasModel: boolean;
}

export interface ChapterColorState {
  index: number;
  totalSentences: number;
  cachedSentences: number;
  fullyColored: boolean;
  missingModel: boolean;
}

export interface RunPatch {
  key: string;
  html: string;
}

export interface ChapterColorPatch {
  book: string;
  chapter: number;
  done: number;
  total: number;
  finished: boolean;
  missingModel: boolean;
  error: string | null;
  patches: RunPatch[];
}

/**
 * The `models-missing` prefix the analyzer uses when no weights are installed.
 */
export const MODEL_MISSING = "models-missing";

/** The message an IPC error carries: Tauri rejects with a string. */
export function message(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "出了点问题。";
}

/** A `book-missing` / `chapter-missing` / `models-missing` prefix, or `null`. */
export function commandPrefix(error: unknown): string | null {
  const match = /^([a-z-]+):/.exec(message(error));
  return match ? match[1] : null;
}

export const bookOpen = (id: string) => invoke<BookView>("book_open", { id });

export const bookChapterColorize = (id: string, index: number) =>
  invoke<ChapterColorState>("book_chapter_colorize", { id, index });

export const bookChapterPrefetch = (id: string, index: number) =>
  invoke<void>("book_chapter_prefetch", { id, index });

export const bookChapterCancelStream = () =>
  invoke<void>("book_chapter_cancel_stream");

export const bookProgressSave = (
  id: string,
  chapterIndex: number,
  paragraphIndex: number | null,
  ratio: number,
) =>
  invoke<void>("book_progress_save", {
    id,
    chapterIndex,
    paragraphIndex,
    ratio,
  });

export const CHAPTER_PATCH_EVENT = "chapter://color-patch";

export async function onChapterColorPatch(
  handler: (patch: ChapterColorPatch) => void,
) {
  return listen<ChapterColorPatch>(CHAPTER_PATCH_EVENT, (event) =>
    handler(event.payload),
  );
}

/**
 * How far a whole-book coloring job has got.
 */
export interface ColoringProgress {
  book: string;
  done: number;
  total: number;
  chapters: number;
  chaptersTotal: number;
  finished: boolean;
  cancelled: boolean;
  error: string | null;
}

/** The event the backend emits for every change of a coloring job. */
export const COLORING_EVENT = "coloring://progress";

export const colorizeBook = (id: string) => invoke<void>("colorize_book", { id });

export const coloringProgress = () =>
  invoke<ColoringProgress | null>("coloring_progress");

export const cancelColorizeBook = () => invoke<void>("colorize_book_cancel");

export const clearBookCache = (id: string) => invoke<void>("clear_book_cache", { id });

export const bookHasColoring = (id: string) => invoke<boolean>("book_has_coloring", { id });

export const bookHasActiveColoring = (id: string) =>
  invoke<boolean>("book_has_active_coloring", { id });

export async function onColoringProgress(
  handler: (progress: ColoringProgress) => void,
) {
  return listen<ColoringProgress>(COLORING_EVENT, (event) => handler(event.payload));
}
