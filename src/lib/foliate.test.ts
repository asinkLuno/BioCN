/**
 * Pins the shape of what the reader hands to foliate-js.
 *
 * The seam module talks to the real library in dev; here only its inputs and
 * outputs are checked, without opening a book.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBookBlob } from "./foliate";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

describe("fetchBookBlob", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps the stored EPUB in a named File, not a bare Blob", async () => {
    // foliate's zip branch asks `isCBZ`/`isFBZ`, which destructure
    // `{ name, type }` and call `name.endsWith(...)` — a bare Blob has no
    // name and crashed the open with "undefined is not an object".
    const blob = new Blob(["PK\x03\x04 fake epub"]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, blob: async () => blob }),
    );

    const file = await fetchBookBlob("/books/dune.epub");
    expect(file.name).toBe("book.epub");
    expect(file.type).toBe("application/epub+zip");
    expect(file.size).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledWith("asset://localhost//books/dune.epub");
  });

  it("surfaces a failed fetch as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );
    await expect(fetchBookBlob("/books/gone.epub")).rejects.toThrow("无法读取书文件（404）");
  });
});
