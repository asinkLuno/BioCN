/**
 * Typed bridge to the Rust `models` module.
 *
 * Unlike the library commands, the model download is a long job with progress,
 * so this module also owns the `models://progress` subscription. The Rust side
 * emits absolute numbers per file; the sheet turns them into one bar for the
 * whole variant.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** The two published weight sets. `int8` is small, `fp16` is accurate. */
export type VariantId = "int8" | "fp16";

export interface VariantStatus {
  id: VariantId;
  label: string;
  description: string;
  /** Download size in bytes as published; 0 when the manifest is unreachable. */
  bytes: number;
  /** Bytes already on disk (the installed stamp size); 0 before first install. Mirrors Rust `VariantStatus.size`. */
  size: number;
  /** Bytes of an interrupted attempt already on disk, for "resume". */
  partial: number;
}

export interface ModelStatus {
  /** Every variant that has a stamp on disk, in no guaranteed order. */
  installed: VariantId[];
  /** The variant the reader loads; null when nothing is installed or chosen. */
  active: VariantId | null;
  variants: VariantStatus[];
  /** Why the published sizes are unknown; the page shows it with the offline hint. */
  manifestError: string | null;
  /** A non-fatal notice from the last operation (weights still on disk). */
  warning: string | null;
}

export interface ModelProgress {
  variant: VariantId;
  file: string;
  /**
   * Bytes of the *whole variant* written so far, counting the files already
   * finished: the Rust side adds them, so this is directly a progress ratio.
   */
  done: number;
  /** Bytes of the whole variant, all files together. */
  total: number;
}

export const modelsStatus = () => invoke<ModelStatus>("models_status");

export const modelsInstall = (variant: VariantId) =>
  invoke<ModelStatus>("models_install", { variant });

export const modelsRemove = (variant: VariantId) =>
  invoke<ModelStatus>("models_remove", { variant });

/** Points the reader at an installed variant; the next analysis loads it. */
export const modelsActivate = (variant: VariantId) =>
  invoke<ModelStatus>("models_activate", { variant });

/**
 * Subscribes to download progress. Returns the unsubscribe function.
 *
 * The listener is registered before the install starts (the caller awaits this)
 * so the first progress events are not missed: a fast local copy can finish
 * before a listener registered afterwards is attached.
 */
export async function onModelProgress(handler: (progress: ModelProgress) => void) {
  return listen<ModelProgress>("models://progress", (event) => handler(event.payload));
}

/** `78 MB` / `1.2 GB`, matching the size column in the model sheet. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "大小未知";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${value} ${units[unit]}`
    : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
