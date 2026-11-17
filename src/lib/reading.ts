/**
 * Typed bridge to the Rust `settings` and `reader` modules.
 *
 * Shapes here mirror `src-tauri/src/settings.rs`, `analyzer.rs` and `reading.rs`
 * field for field; the offsets are UTF-16 because that is what a DOM `Range`
 * uses.
 */
import { invoke } from "@tauri-apps/api/core";

/** `normal` spans are the sentence's punctuation and untouched words. */
export type Role = "normal" | "subject" | "predicate" | "object";

export interface Segment {
  text: string;
  /** UTF-16 offset of the span within its *sentence*. */
  start: number;
  role: Role;
}

export interface ColoredSentence {
  text: string;
  /** UTF-16 offset of the sentence within its paragraph. */
  start: number;
  segments: Segment[];
}

export interface ColoredParagraph {
  text: string;
  sentences: ColoredSentence[];
}

export interface ChapterSummary {
  index: number;
  title: string | null;
  paragraphs: number;
}

export interface BookView {
  id: string;
  title: string;
  chapters: ChapterSummary[];
}

export interface ChapterView {
  index: number;
  title: string | null;
  paragraphs: ColoredParagraph[];
}

/**
 * The `models-missing` prefix the analyzer uses when no weights are installed.
 *
 * A prefix rather than an error type because a command error crosses the IPC
 * bridge as a string; the reader turns it into the "download a model" prompt
 * instead of showing the raw message.
 */
export const MODEL_MISSING = "models-missing";

/** The message an IPC error carries: Tauri rejects with a string. */
export function message(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/** A `book-missing` / `chapter-missing` / `models-missing` prefix, or `null`. */
export function commandPrefix(error: unknown): string | null {
  const match = /^([a-z-]+):/.exec(message(error));
  return match ? match[1] : null;
}

export const bookOpen = (id: string) => invoke<BookView>("book_open", { id });

export const bookChapter = (id: string, index: number) =>
  invoke<ChapterView>("book_chapter", { id, index });
