/**
 * Typed bridge to the Rust `library` module.
 *
 * The Rust side owns all disk state; this module only mirrors its shapes.
 */
import { invoke } from "@tauri-apps/api/core";

export interface Book {
  id: string;
  title: string;
  authors: string[];
  /** Milliseconds since the Unix epoch. */
  addedAt: number;
  /** Size in bytes of the stored file. */
  size: number;
  hasCover: boolean;
}

export interface ImportError {
  name: string;
  message: string;
}

export interface ImportReport {
  library: Book[];
  added: Book[];
  errors: ImportError[];
}

export interface CoverImage {
  mime: string;
  base64: string;
}

export const libraryList = () => invoke<Book[]>("library_list");

export const libraryImport = (paths: string[]) =>
  invoke<ImportReport>("library_import", { paths });

export const libraryRemove = (id: string) => invoke<Book[]>("library_remove", { id });

export const libraryCover = (id: string) => invoke<CoverImage | null>("library_cover", { id });
