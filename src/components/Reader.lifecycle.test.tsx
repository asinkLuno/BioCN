import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as reading from "../lib/reading";
import { Reader } from "./Reader";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(() => true),
  convertFileSrc: vi.fn((_path: string, protocol = "asset") => `${protocol}://localhost/`),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/fonts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/fonts")>()),
  fontStatus: vi.fn().mockResolvedValue({
    installed: true,
    bytes: 16_708_168,
    size: 16_708_168,
    partial: 0,
  }),
  fontInstall: vi.fn(),
  fontRemove: vi.fn(),
  onFontProgress: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../lib/reading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/reading")>()),
  bookOpen: vi.fn(),
  bookChapterColorize: vi.fn(),
  bookChapterPrefetch: vi.fn(),
  bookChapterCancelStream: vi.fn(),
  bookProgressSave: vi.fn(),
  onChapterColorPatch: vi.fn(),
}));

const openMock = vi.mocked(reading.bookOpen);
const colorizeMock = vi.mocked(reading.bookChapterColorize);
const prefetchMock = vi.mocked(reading.bookChapterPrefetch);
const cancelStreamMock = vi.mocked(reading.bookChapterCancelStream);
const progressSaveMock = vi.mocked(reading.bookProgressSave);
const onPatchMock = vi.mocked(reading.onChapterColorPatch);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function makeBook(id: string, title: string): reading.BookView {
  return {
    id,
    title,
    hasModel: true,
    initialChapter: 1,
    progress: null,
    chapters: [
      { index: 1, manifestId: "p1", href: "OEBPS/1.xhtml", title: `${title} One`, colored: true },
      { index: 2, manifestId: "p2", href: "OEBPS/2.xhtml", title: `${title} Two`, colored: false },
    ],
    toc: [],
  };
}

const first = makeBook("a", "Book A");
const second = makeBook("b", "Book B");
const baseProps = { onClose: vi.fn(), onOpenSettings: vi.fn(), modelsOpen: false };

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  openMock.mockImplementation(async (id) => (id === "b" ? second : first));
  colorizeMock.mockImplementation(async (_id, index) => ({
    index,
    totalSentences: 5,
    cachedSentences: 5,
    fullyColored: true,
    missingModel: false,
  }));
  prefetchMock.mockResolvedValue(undefined);
  cancelStreamMock.mockResolvedValue(undefined);
  progressSaveMock.mockResolvedValue(undefined);
  onPatchMock.mockResolvedValue(() => {});
});

describe("Reader lifecycle", () => {
  it("retries opening a book after an open failure", async () => {
    openMock.mockRejectedValueOnce(new Error("temporary open failure"));
    render(<Reader id="a" {...baseProps} />);
    const alert = await screen.findByRole("alert");
    await userEvent.click(within(alert).getByRole("button", { name: "重试" }));
    await screen.findByTitle("Book A One");
    expect(openMock).toHaveBeenCalledTimes(2);
  });

  it("does not let a slow stale book open replace the current book", async () => {
    const slow = deferred<reading.BookView>();
    openMock.mockImplementation((id) => (id === "a" ? slow.promise : Promise.resolve(second)));
    const { rerender } = render(<Reader id="a" {...baseProps} />);
    rerender(<Reader id="b" {...baseProps} />);
    await screen.findByTitle("Book B One");
    await act(async () => slow.resolve(first));
    expect(screen.getByText("Book B")).toBeInTheDocument();
    expect(screen.getByTitle("Book B One")).toBeInTheDocument();
    expect(colorizeMock).not.toHaveBeenCalledWith("a", expect.any(Number));
  });

  it("cancels background reader coloring stream and flushes progress on unmount", async () => {
    const { unmount } = render(<Reader id="a" {...baseProps} />);
    const frame = (await screen.findByTitle("Book A One")) as HTMLIFrameElement;
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            source: "biocn-reader",
            type: "progress",
            mode: "scrolled",
            page: 0,
            totalPages: 1,
            ratio: 0.6,
            paragraphIndex: 4,
          },
          source: frame.contentWindow,
        }),
      );
    });
    unmount();
    expect(cancelStreamMock).toHaveBeenCalledTimes(1);
    expect(progressSaveMock).toHaveBeenCalledWith("a", 1, 4, 0.6);
  });

  it("reloads the chapter URL and re-triggers coloring when modelRevision changes", async () => {
    const { rerender } = render(<Reader id="a" {...baseProps} modelRevision={0} />);
    const frame = await screen.findByTitle("Book A One");
    expect(frame.getAttribute("src")).toMatch(/^book:\/\/localhost\/a\/OEBPS\/1\.xhtml\?theme=/);

    rerender(<Reader id="a" {...baseProps} modelRevision={1} />);
    await waitFor(() => {
      const frames = screen.getAllByTitle("Book A One");
      expect(
        frames.some((el) =>
          /^book:\/\/localhost\/a\/OEBPS\/1\.xhtml\?v=1000&/.test(el.getAttribute("src") ?? ""),
        ),
      ).toBe(true);
    });
    // Also refreshes bookOpen metadata so TOC colored badges reflect the new model.
    expect(openMock).toHaveBeenCalledTimes(2);
  });

  it("does not let a late bookChapterColorize snapshot overwrite an already-finished patch event", async () => {
    let emitPatch: ((event: reading.ChapterColorPatch) => void) | null = null;
    onPatchMock.mockImplementation(async (cb) => {
      emitPatch = cb;
      return () => {};
    });
    const slowColorize = deferred<reading.ChapterColorState>();
    colorizeMock.mockReturnValue(slowColorize.promise);

    render(<Reader id="a" {...baseProps} />);
    await screen.findByTitle("Book A One");
    await waitFor(() => expect(emitPatch).not.toBeNull());

    // Patch event finishes BEFORE bookChapterColorize resolves.
    act(() => {
      emitPatch!({
        book: "a",
        chapter: 1,
        done: 10,
        total: 10,
        finished: true,
        missingModel: false,
        error: null,
        patches: [],
      });
    });

    // Late initial snapshot arrives saying 0/10 cached, not fully colored.
    await act(async () => {
      slowColorize.resolve({
        index: 1,
        totalSentences: 10,
        cachedSentences: 0,
        fullyColored: false,
        missingModel: false,
      });
    });

    // Spinner ("本章着色进度") must NOT reappear stuck on screen.
    expect(screen.queryByRole("status", { name: "本章着色进度" })).toBeNull();
  });

  it("allows Escape to close the Aa popover even when an input slider has focus", async () => {
    const user = userEvent.setup();
    render(<Reader id="a" {...baseProps} />);
    await screen.findByTitle("Book A One");

    await user.click(screen.getByRole("button", { name: "阅读设置" }));
    const fontSlider = screen.getByRole("slider", { name: "字号" });
    fontSlider.focus();
    expect(document.activeElement).toBe(fontSlider);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("slider", { name: "字号" })).toBeNull();
  });
});
