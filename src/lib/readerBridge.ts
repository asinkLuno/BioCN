/**
 * Typed `postMessage` contract between React `Reader` (host) and the chapter
 * iframe's injected `bridge.js`.
 */
import type { RunPatch } from "./reading";
import type { ReaderPrefs, ReaderViewMode } from "./readerPrefs";

export interface ChapterTarget {
  anchor?: string | null;
  paragraphIndex?: number | null;
  ratio?: number | null;
  edge?: "start" | "end";
}

export type HostToFrameMessage =
  | { source: "biocn-host"; type: "init"; prefs: ReaderPrefs; target?: ChapterTarget }
  | { source: "biocn-host"; type: "prefs"; prefs: ReaderPrefs }
  | { source: "biocn-host"; type: "patch"; patches: RunPatch[] }
  | { source: "biocn-host"; type: "step"; direction: "prev" | "next" }
  | { source: "biocn-host"; type: "seek"; ratio: number }
  | { source: "biocn-host"; type: "jump"; anchor?: string | null; paragraphIndex?: number | null };

export type FrameToHostMessage =
  | { source: "biocn-reader"; type: "ready" }
  | { source: "biocn-reader"; type: "painted" }
  | {
      source: "biocn-reader";
      type: "progress";
      mode: ReaderViewMode;
      page: number;
      totalPages: number;
      ratio: number;
      paragraphIndex: number | null;
    }
  | { source: "biocn-reader"; type: "turn"; direction: "prev" | "next" }
  | { source: "biocn-reader"; type: "link"; href: string }
  | { source: "biocn-reader"; type: "external"; href: string }
  | { source: "biocn-reader"; type: "key"; key: string }
  | { source: "biocn-reader"; type: "tap" };

const EXTERNAL_SCHEME_RE = /^(https?:|mailto:|tel:)/i;

export function isFrameMessage(data: unknown): data is FrameToHostMessage {
  if (typeof data !== "object" || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.source !== "biocn-reader" || typeof msg.type !== "string") return false;
  switch (msg.type) {
    case "ready":
    case "painted":
    case "tap":
      return true;
    case "progress":
      return (
        (msg.mode === "scrolled" || msg.mode === "paginated") &&
        typeof msg.page === "number" &&
        Number.isFinite(msg.page) &&
        typeof msg.totalPages === "number" &&
        Number.isFinite(msg.totalPages) &&
        typeof msg.ratio === "number" &&
        Number.isFinite(msg.ratio) &&
        (msg.paragraphIndex === null ||
          (typeof msg.paragraphIndex === "number" && Number.isFinite(msg.paragraphIndex)))
      );
    case "turn":
      return msg.direction === "prev" || msg.direction === "next";
    case "link":
      return typeof msg.href === "string" && msg.href.length > 0;
    case "external":
      return typeof msg.href === "string" && EXTERNAL_SCHEME_RE.test(msg.href);
    case "key":
      return typeof msg.key === "string";
    default:
      return false;
  }
}

export function postToFrame(
  frame: HTMLIFrameElement | null,
  message: HostToFrameMessage,
): void {
  frame?.contentWindow?.postMessage(message, "*");
}
