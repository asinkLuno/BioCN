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

export function isFrameMessage(data: unknown): data is FrameToHostMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === "biocn-reader" &&
    typeof (data as { type?: unknown }).type === "string"
  );
}

export function postToFrame(
  frame: HTMLIFrameElement | null,
  message: HostToFrameMessage,
): void {
  frame?.contentWindow?.postMessage(message, "*");
}
