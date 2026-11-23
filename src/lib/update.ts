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
  /** The installer for this build; null when the current platform has no published asset. */
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

/** Android「安装未知应用」授权状态（supported=false 表示当前平台不支持应用内安装）。 */
export interface InstallPermission {
  supported: boolean;
  granted: boolean;
}

export const checkUpdate = () => invoke<UpdateStatus>("check_update");

export const downloadUpdate = (url: string, sha256: string) =>
  invoke<{ path: string; bytes: number }>("download_update", { url, sha256 });

export const cancelUpdateDownload = () => invoke<boolean>("cancel_update_download");

/** Shows the verified installer in the file manager; refused for foreign paths. */
export const revealUpdate = (path: string) => invoke<void>("reveal_update", { path });

export const installPermission = () => invoke<InstallPermission>("install_permission");

export const openInstallPermissionSettings = () =>
  invoke<void>("open_install_permission_settings");

/** Hands a verified cached APK over to Android's package installer. */
export const installApk = (path: string) => invoke<void>("install_apk", { path });

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

export type ReleaseNoteBlock =
  | { kind: "heading"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "text"; text: string }
  | { kind: "changelog"; label: string; url: string };

const VERSION_TITLE_RE = /^(?:✨\s*)?v?\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?\s*更新内容$/;
const FULL_CHANGELOG_RE =
  /^\*{0,2}Full Changelog\*{0,2}\s*:\s*(?:\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/\S+))$/i;

function inlineText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}

/**
 * 把 Release Markdown 解析为可分层展示的段落块：
 * - 跳过与外层卡片重复的 `## ✨ vX.Y.Z 更新内容` 标题行；
 * - 将 `###` 小节标题识别为 heading，连续的 `- ` / `* ` 条目合并为 list；
 * - 识别末尾 GitHub `Full Changelog` 对比链接（仅接受 https://github.com/）。
 */
export function parseReleaseNotes(markdown: string): ReleaseNoteBlock[] {
  const blocks: ReleaseNoteBlock[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const changelog = FULL_CHANGELOG_RE.exec(line);
    if (changelog) {
      const url = changelog[2] ?? changelog[3];
      if (url?.startsWith("https://github.com/")) {
        blocks.push({ kind: "changelog", label: "查看完整变更对比", url });
        continue;
      }
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const text = inlineText(heading[1]);
      if (text && !VERSION_TITLE_RE.test(text)) {
        blocks.push({ kind: "heading", text });
      }
      continue;
    }

    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      const text = inlineText(item[1]);
      if (!text) continue;
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list") {
        last.items.push(text);
      } else {
        blocks.push({ kind: "list", items: [text] });
      }
      continue;
    }

    const text = inlineText(line);
    if (text) {
      blocks.push({ kind: "text", text });
    }
  }
  return blocks;
}
