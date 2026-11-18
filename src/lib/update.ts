/**
 * Typed bridge to the Rust `update` module (设置 → 版本与更新).
 *
 * Metadata comes from the Pages `releases.json` the release workflow generates
 * from GitHub Releases; the installer bytes come from GitHub Releases itself
 * and are SHA-256-verified while downloading. The Rust side emits absolute
 * byte counts on `update://progress`; the section turns them into one bar.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatBytes } from "./models";

export interface UpdateAsset {
  name: string;
  platform: string;
  size: number;
  /** Empty when the metadata lacks a digest; the section refuses to download then. */
  sha256: string | null;
  url: string;
}

export interface ReleaseInfo {
  version: string;
  notes: string;
  /** Every official installer of the release, in the published order. */
  downloads: UpdateAsset[];
  /** The installer for this build; null where an in-app download can't install (Android). */
  download: UpdateAsset | null;
}

export interface UpdateStatus {
  currentVersion: string;
  latest: ReleaseInfo | null;
}

export interface UpdateProgress {
  received: number;
  total: number;
}

export const checkUpdate = () => invoke<UpdateStatus>("check_update");

export const downloadUpdate = (url: string, sha256: string) =>
  invoke<{ path: string; bytes: number }>("download_update", { url, sha256 });

/** Shows the verified installer in the file manager; refused for foreign paths. */
export const revealUpdate = (path: string) => invoke<void>("reveal_update", { path });

export const openReleasePage = () => invoke<void>("open_release_page");

/**
 * Subscribes to download progress. Returns the unsubscribe function.
 *
 * The listener is registered before the download starts (the caller awaits
 * this) so the first progress events are not missed: a cached CDN response
 * can finish before a listener registered afterwards is attached.
 */
export async function onUpdateProgress(handler: (progress: UpdateProgress) => void) {
  return listen<UpdateProgress>("update://progress", (event) => handler(event.payload));
}

/** `24.7 MB`, matching the size lines in the model sheet. */
export const formatSize = formatBytes;

/** 逐段比较数字版本号（0.4.10 > 0.4.9），长度不同按 0 补齐。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Release 说明 → 逐行纯文本：剥掉标题井号与链接、加粗、行内代码等标记，
 * 条目保留 `- ` 前缀。GitHub 自动生成的说明（Full Changelog 一类）也能读。
 */
export function plainNotes(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*]\s+/, "- ")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/`([^`]*)`/g, "$1"),
    );
}
