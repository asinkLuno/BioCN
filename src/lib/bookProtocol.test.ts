import { describe, expect, it, vi } from "vitest";
import { bookResourceUrl, resolveRelativeHref } from "./bookProtocol";
import { DEFAULT_READER_PREFS } from "./readerPrefs";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(() => true),
  convertFileSrc: vi.fn((_path: string, protocol = "asset") => `${protocol}://localhost/`),
}));

describe("bookProtocol", () => {
  it("builds book:// URLs keeping real slashes and encoding segments", () => {
    expect(bookResourceUrl("abc123", "OEBPS/Text/第 1 章.xhtml")).toBe(
      "book://localhost/abc123/OEBPS/Text/%E7%AC%AC%201%20%E7%AB%A0.xhtml",
    );
    expect(bookResourceUrl("abc123", "OEBPS/ch1.xhtml", 2)).toBe(
      "book://localhost/abc123/OEBPS/ch1.xhtml?v=2",
    );
    const styled = bookResourceUrl("abc123", "OEBPS/ch1.xhtml", 1, DEFAULT_READER_PREFS);
    expect(styled).toContain("theme=auto");
    expect(styled).not.toContain("biocn=");
  });

  it("resolves relative EPUB chapter links and anchors", () => {
    expect(resolveRelativeHref("OEBPS/Text/ch1.xhtml", "../Text/ch2.xhtml#fn-1")).toEqual({
      path: "OEBPS/Text/ch2.xhtml",
      anchor: "fn-1",
    });
    expect(resolveRelativeHref("OEBPS/Text/ch1.xhtml", "#sec2")).toEqual({
      path: "OEBPS/Text/ch1.xhtml",
      anchor: "sec2",
    });
    expect(resolveRelativeHref("OEBPS/Text/ch1.xhtml", "/OEBPS/notes.xhtml")).toEqual({
      path: "OEBPS/notes.xhtml",
      anchor: null,
    });
  });
});
