import { open } from "@tauri-apps/plugin-dialog";
import { describe, expect, it, vi } from "vitest";
import { epubFilter, isMobile } from "./picker";

const openMock = vi.mocked(open);

const DESKTOP = {
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
  platform: "Linux x86_64",
  maxTouchPoints: 0,
};

const ANDROID = {
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130 Mobile Safari/537.36",
  platform: "Linux armv8l",
  maxTouchPoints: 5,
};

const IPAD = {
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  platform: "MacIntel",
  maxTouchPoints: 5,
};

describe("epub picker", () => {
  it("filters by .epub extension on desktop", () => {
    expect(isMobile(DESKTOP)).toBe(false);
    expect(epubFilter(isMobile(DESKTOP))).toEqual({
      name: "EPUB",
      extensions: ["epub"],
    });
  });

  it("filters by EPUB MIME type on Android, which ignores extensions", () => {
    const filter = epubFilter(isMobile(ANDROID));

    expect(filter.extensions).toContain("application/epub+zip");
    expect(filter.extensions).not.toContain("epub");
  });

  it("treats iPadOS, which reports a Mac platform, as mobile", () => {
    expect(isMobile(IPAD)).toBe(true);
    expect(epubFilter(isMobile(IPAD)).extensions).toContain("application/epub+zip");
  });

  it("opens a multi-select file dialog and unwraps the cancelled case", async () => {
    const { pickEpubFiles } = await import("./picker");

    openMock.mockResolvedValueOnce("/books/dune.epub");
    expect(await pickEpubFiles()).toEqual(["/books/dune.epub"]);
    expect(openMock.mock.calls[0][0]).toMatchObject({
      multiple: true,
      directory: false,
      filters: [{ name: "EPUB", extensions: ["epub"] }],
    });

    openMock.mockResolvedValueOnce(null);
    expect(await pickEpubFiles()).toEqual([]);

    openMock.mockResolvedValueOnce(["/a.epub", "/b.epub"]);
    expect(await pickEpubFiles()).toEqual(["/a.epub", "/b.epub"]);
  });
});
