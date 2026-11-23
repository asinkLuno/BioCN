/**
 * Typed bridge to the Rust `fonts` module (on-demand Source Han Serif SC).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface FontStatus {
  installed: boolean;
  /** Published download size in bytes (always known offline). */
  bytes: number;
  /** Bytes installed on disk; 0 when not installed. */
  size: number;
  /** Bytes already downloaded in `.part` from an interrupted attempt. */
  partial: number;
}

export interface FontProgress {
  done: number;
  total: number;
}

export const fontStatus = () => invoke<FontStatus>("font_status");

export const fontInstall = () => invoke<FontStatus>("font_install");

export const fontCancel = () => invoke<boolean>("font_cancel");

export const fontRemove = () => invoke<FontStatus>("font_remove");

/**
 * Subscribes to serif font download progress. Returns the unsubscribe function.
 */
export async function onFontProgress(handler: (progress: FontProgress) => void) {
  return listen<FontProgress>("fonts://progress", (event) => handler(event.payload));
}
