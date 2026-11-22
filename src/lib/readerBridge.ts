/**
 * Typed `postMessage` contract between React `Reader` (host) and the chapter
 * iframe's injected `bridge.js`.
 */

import type { ReaderPrefs, ReaderViewMode } from "./readerPrefs";
import type { RunPatch } from "./reading";

export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type FootnoteTrigger = "hover" | "click";

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
  | { source: "biocn-host"; type: "jump"; anchor?: string | null; paragraphIndex?: number | null }
  | {
      source: "biocn-host";
      type: "resolve-footnote";
      requestId: number;
      href: string;
      anchor: string;
    };

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
  | { source: "biocn-reader"; type: "link"; href: string; rect?: AnchorRect }
  | {
      source: "biocn-reader";
      type: "footnote";
      href: string;
      anchor: string;
      label: string;
      html: string;
      sameChapter: boolean;
      trigger?: FootnoteTrigger;
      rect?: AnchorRect;
    }
  | { source: "biocn-reader"; type: "footnote-leave" }
  | {
      source: "biocn-reader";
      type: "footnote-result";
      requestId: number;
      href: string;
      anchor: string;
      found: boolean;
      label?: string;
      html?: string;
    }
  | { source: "biocn-reader"; type: "external"; href: string }
  | { source: "biocn-reader"; type: "key"; key: string }
  | { source: "biocn-reader"; type: "tap" };

const EXTERNAL_SCHEME_RE = /^(https?:|mailto:|tel:)/i;

function isAnchorRect(value: unknown): value is AnchorRect {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.top === "number" &&
    Number.isFinite(r.top) &&
    typeof r.bottom === "number" &&
    Number.isFinite(r.bottom) &&
    typeof r.left === "number" &&
    Number.isFinite(r.left) &&
    typeof r.right === "number" &&
    Number.isFinite(r.right)
  );
}

export function isFrameMessage(data: unknown): data is FrameToHostMessage {
  if (typeof data !== "object" || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.source !== "biocn-reader" || typeof msg.type !== "string") return false;
  switch (msg.type) {
    case "ready":
    case "painted":
    case "tap":
    case "footnote-leave":
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
      return (
        typeof msg.href === "string" &&
        msg.href.length > 0 &&
        (msg.rect === undefined || isAnchorRect(msg.rect))
      );
    case "footnote":
      return (
        typeof msg.href === "string" &&
        msg.href.length > 0 &&
        typeof msg.anchor === "string" &&
        msg.anchor.length > 0 &&
        typeof msg.label === "string" &&
        typeof msg.html === "string" &&
        msg.html.length > 0 &&
        typeof msg.sameChapter === "boolean" &&
        (msg.trigger === undefined || msg.trigger === "hover" || msg.trigger === "click") &&
        (msg.rect === undefined || isAnchorRect(msg.rect))
      );
    case "footnote-result":
      return (
        typeof msg.requestId === "number" &&
        Number.isFinite(msg.requestId) &&
        typeof msg.href === "string" &&
        msg.href.length > 0 &&
        typeof msg.anchor === "string" &&
        msg.anchor.length > 0 &&
        typeof msg.found === "boolean" &&
        (msg.label === undefined || typeof msg.label === "string") &&
        (msg.html === undefined || typeof msg.html === "string")
      );
    case "external":
      return typeof msg.href === "string" && EXTERNAL_SCHEME_RE.test(msg.href);
    case "key":
      return typeof msg.key === "string";
    default:
      return false;
  }
}

export function postToFrame(frame: HTMLIFrameElement | null, message: HostToFrameMessage): void {
  frame?.contentWindow?.postMessage(message, "*");
}
