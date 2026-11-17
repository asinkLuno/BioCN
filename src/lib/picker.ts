/**
 * Cross-platform EPUB file picker.
 *
 * Desktop uses native file dialogs with an extension filter. Android turns
 * filters into MIME types, so it gets explicit EPUB MIME types instead of the
 * `epub` extension — otherwise the document picker greys every book out.
 */
import { open } from "@tauri-apps/plugin-dialog";

interface NavigatorLike {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

/** iPadOS reports a Mac platform, so touch points are the tell. */
export function isMobile(nav: NavigatorLike = navigator) {
  return (
    /Android|iPhone|iPad|iPod/i.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1)
  );
}

export function epubFilter(mobile = isMobile()) {
  return mobile
    ? // Some providers report EPUB files as generic binary.
      { name: "EPUB", extensions: ["application/epub+zip", "application/octet-stream"] }
    : { name: "EPUB", extensions: ["epub"] };
}

/** Returns the picked EPUB paths/URIs, or an empty array when cancelled. */
export async function pickEpubFiles(): Promise<string[]> {
  const selected = await open({
    multiple: true,
    directory: false,
    title: "把书添加到书架",
    filters: [epubFilter()],
  });

  if (selected === null) return [];
  return Array.isArray(selected) ? selected : [selected];
}
