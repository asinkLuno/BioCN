import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reader } from "./Reader";
import * as reading from "../lib/reading";
import * as epub from "../lib/epub";

vi.mock("../lib/reading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/reading")>()),
  bookOpen: vi.fn(),
  bookChapter: vi.fn(),
}));

vi.mock("../lib/epub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/epub")>()),
  openColoredBook: vi.fn(),
  fetchBookBlob: vi.fn(),
}));

const openMock = vi.mocked(reading.bookOpen);
const chapterMock = vi.mocked(reading.bookChapter);
const openColoredBookMock = vi.mocked(epub.openColoredBook);
const fetchBlobMock = vi.mocked(epub.fetchBookBlob);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(id: string, title: string) {
  const unloads = [vi.fn(), vi.fn(), vi.fn()];
  const loads = [vi.fn(), vi.fn(), vi.fn()];
  const book = {
    sections: [0, 1, 2].map((index) => ({
      id: `OPS/Text/${index}.xhtml`,
      href: `OPS/Text/${index}.xhtml`,
      index,
      linear: "yes",
      size: 0,
      load: loads[index].mockResolvedValue(`blob:${id}-${index}`),
      unload: unloads[index],
    })),
    resources: { getItemByID: (manifestId: string) => ({ href: `OPS/Text/${manifestId === "part-2" ? 2 : 1}.xhtml` }) },
    toc: [],
    resolveHref: () => null,
    isExternal: () => false,
    destroy: vi.fn(),
  } as unknown as epub.ColoredBook["book"];
  const view: reading.BookView = {
    id,
    filePath: `${id}.epub`,
    title,
    chapters: [
      { index: 1, manifestId: "part-1", title: `${title} One`, paragraphs: 1 },
      { index: 2, manifestId: "part-2", title: `${title} Two`, paragraphs: 1 }
    ],
  };
  return { book, view, loads, unloads };
}

function chapter(index: number, title: string): reading.ChapterView {
  return { index, manifestId: `part-${index}`, title, html: "<p>text</p>" };
}

const props = { onClose: vi.fn(), onOpenSettings: vi.fn(), modelsOpen: false };

beforeEach(() => {
  vi.clearAllMocks();
  openMock.mockImplementation(async (id) => id === "b" ? second.view : first.view);
  openColoredBookMock.mockImplementation(async (file) => {
    const chosen = file instanceof File && file.name.startsWith("b") ? second : first;
    return { book: chosen.book, put: vi.fn() };
  });
  fetchBlobMock.mockImplementation(async (path) => new File(["PK"], path));
  chapterMock.mockImplementation(async (_id, index) => chapter(index, `Chapter ${index}`));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "<html><head></head><body><p>text</p></body></html>" })));
});

afterEach(() => vi.unstubAllGlobals());

const first = fixture("a", "Book A");
const second = fixture("b", "Book B");

describe("Reader lifecycle", () => {
  it("retries opening a book after an open failure", async () => {
    openMock.mockRejectedValueOnce(new Error("temporary open failure"));
    render(<Reader id="a" {...props} />);
    const alert = await screen.findByRole("alert");
    await userEvent.click(within(alert).getByRole("button", { name: "重试" }));
    await screen.findByTitle("Chapter 1");
    expect(openMock).toHaveBeenCalledTimes(2);
  });

  it("does not let a slow stale book open replace the current book", async () => {
    const slow = deferred<reading.BookView>();
    openMock.mockImplementation((id) => id === "a" ? slow.promise : Promise.resolve(second.view));
    const { rerender } = render(<Reader id="a" {...props} />);
    rerender(<Reader id="b" {...props} />);
    await screen.findByTitle("Chapter 1");
    await act(async () => slow.resolve(first.view));
    expect(screen.getByText("Book B")).toBeInTheDocument();
    expect(screen.getByTitle("Chapter 1")).toBeInTheDocument();
    expect(chapterMock).not.toHaveBeenCalledWith("a", expect.any(Number));
  });

  it("unloads a section when a slower load loses the navigation race", async () => {
    const slow = deferred<string | null>();
    first.loads[1].mockReturnValueOnce(slow.promise);
    const { unmount } = render(<Reader id="a" {...props} />);
    await waitFor(() => expect(first.loads[1]).toHaveBeenCalled());
    await act(async () => {
      // Finish opening chapter 2 while chapter 1's section is still loading.
      chapterMock.mockImplementation(async (_id, index) => chapter(index, `Chapter ${index}`));
      screen.getByRole("button", { name: "下一章" }).click();
    });
    await waitFor(() => expect(chapterMock).toHaveBeenCalledWith("a", 2));
    await act(async () => slow.resolve("blob:stale"));
    await screen.findByTitle("Chapter 2");
    expect(first.unloads[1]).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalledWith("blob:stale");
    unmount();
  });

  it("ignores an old response body that finishes after the next chapter renders", async () => {
    const body = deferred<string>();
    const text = vi.fn(() => body.promise);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, text } as unknown as Response);
    render(<Reader id="a" {...props} />);
    await waitFor(() => expect(text).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "下一章" }));
    await screen.findByTitle("Chapter 2");
    await act(async () => body.resolve("<p>stale body</p>"));
    expect(screen.getByTitle("Chapter 2").getAttribute("srcdoc")).not.toContain("stale body");
    expect(first.unloads[1]).toHaveBeenCalledTimes(1);
  });
  it("unloads acquired sections and destroys the book on unmount", async () => {
    const { unmount } = render(<Reader id="a" {...props} />);
    await screen.findByTitle("Chapter 1");
    unmount();
    expect(first.unloads[1]).toHaveBeenCalledTimes(1);
    expect(first.book.destroy).toHaveBeenCalledTimes(1);
  });

  it("releases the iframe keyboard listener on unmount", async () => {
    const onClose = vi.fn();
    const { unmount } = render(<Reader id="a" {...props} onClose={onClose} />);
    const frame = await screen.findByTitle("Chapter 1") as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    await act(async () => doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
