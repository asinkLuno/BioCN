/**
 * Builds platform-correct URLs for the Rust `book://` custom URI scheme
 * protocol and resolves relative EPUB internal links.
 */
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import type { ReaderPrefs } from "./readerPrefs";

function protocolOrigin(): string {
  if (isTauri()) {
    try {
      // `convertFileSrc("", "book")` yields `book://localhost/` on Linux/macOS/iOS
      // and `http://book.localhost/` (or https) on Windows/Android.
      const base = convertFileSrc("", "book");
      if (base) return base.endsWith("/") ? base : `${base}/`;
    } catch {
      // Fallback below
    }
  }
  return "book://localhost/";
}

/**
 * URL for a chapter or resource inside `bookId`.
 *
 * Path segments are encoded individually while preserving real `/` separators
 * so the browser resolves relative images, stylesheets, and fonts natively.
 * Optional `initialPrefs` are embedded as query parameters so Rust stamps the
 * active theme/mode onto `<html>` before the very first paint (no white flash).
 */
export function bookResourceUrl(
  bookId: string,
  href: string,
  revision = 0,
  initialPrefs?: ReaderPrefs,
): string {
  const encodedPath = href
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const base = `${protocolOrigin()}${encodeURIComponent(bookId)}/${encodedPath}`;
  const params: string[] = [];
  if (revision > 0) params.push(`v=${revision}`);
  if (initialPrefs) {
    params.push(`theme=${initialPrefs.theme}`);
    params.push(`mode=${initialPrefs.viewMode}`);
    params.push(`biocn=${initialPrefs.coloringEnabled ? "on" : "off"}`);
    params.push(`font=${initialPrefs.fontFamily}`);
    params.push(`margin=${initialPrefs.pageMargin}`);
    params.push(`align=${initialPrefs.textAlign}`);
    params.push(`dim=${initialPrefs.dimImagesInDark ? "on" : "off"}`);
    if (initialPrefs.svoColors.subject) {
      params.push(`cs=${initialPrefs.svoColors.subject.slice(1)}`);
    }
    if (initialPrefs.svoColors.predicate) {
      params.push(`cp=${initialPrefs.svoColors.predicate.slice(1)}`);
    }
    if (initialPrefs.svoColors.object) {
      params.push(`co=${initialPrefs.svoColors.object.slice(1)}`);
    }
    params.push(`fs=${initialPrefs.fontSize}`);
    params.push(`lh=${initialPrefs.lineHeight.toFixed(1)}`);
    params.push(`ps=${initialPrefs.paragraphSpacing.toFixed(1)}`);
  }
  return params.length > 0 ? `${base}?${params.join("&")}` : base;
}

export interface ResolvedBookLink {
  path: string;
  anchor: string | null;
}

/**
 * Resolves a relative link inside an EPUB chapter (e.g. `../Text/ch2.xhtml#fn1`)
 * against the current chapter's container path (`OEBPS/Text/ch1.xhtml`).
 */
export function resolveRelativeHref(
  currentHref: string,
  rawHref: string,
): ResolvedBookLink | null {
  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  const hashIndex = trimmed.indexOf("#");
  const rawPath = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const rawAnchor = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : "";
  const anchor = rawAnchor ? safeDecode(rawAnchor) : null;

  if (!rawPath) {
    return { path: normalizePath(currentHref), anchor };
  }

  const baseDir = currentHref.includes("/")
    ? currentHref.slice(0, currentHref.lastIndexOf("/") + 1)
    : "";
  const combined = rawPath.startsWith("/") ? rawPath.slice(1) : `${baseDir}${rawPath}`;
  const path = normalizePath(safeDecode(combined));
  if (!path) return null;
  return { path, anchor };
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join("/");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
