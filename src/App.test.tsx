import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as library from "./lib/library";
import * as reading from "./lib/reading";
import * as exporting from "./lib/exporting";
import { open, save } from "@tauri-apps/plugin-dialog";

vi.mock("./lib/library", () => ({
  libraryList: vi.fn(),
  libraryImport: vi.fn(),
  libraryRemove: vi.fn(),
  libraryCover: vi.fn(),
}));

// The reader loads a book on mount; the shelf tests only need it not to talk
// to the backend.
vi.mock("./components/Reader", () => ({
  Reader: ({ id }: { id: string }) => <div role="main">reading {id}</div>,
}));

// The coloring bridge is mocked at the module boundary, not `invoke`: the shelf
// deals in jobs and progress, and asserting on those is what these tests are
// about.
vi.mock("./lib/reading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/reading")>()),
  colorizeBook: vi.fn(),
  coloringProgress: vi.fn(),
  cancelColorizeBook: vi.fn(),
  clearBookCache: vi.fn(),
  bookHasColoring: vi.fn(),
  bookHasActiveColoring: vi.fn(),
  onColoringProgress: vi.fn(),
}));

vi.mock("./lib/exporting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/exporting")>()),
  exportBook: vi.fn(),
}));

const openMock = vi.mocked(open);
const saveMock = vi.mocked(save);
const exportMock = vi.mocked(exporting.exportBook);
const listMock = vi.mocked(library.libraryList);
const importMock = vi.mocked(library.libraryImport);
const removeMock = vi.mocked(library.libraryRemove);
const coverMock = vi.mocked(library.libraryCover);
const colorizeMock = vi.mocked(reading.colorizeBook);
const progressMock = vi.mocked(reading.coloringProgress);
const cancelMock = vi.mocked(reading.cancelColorizeBook);
const clearCacheMock = vi.mocked(reading.clearBookCache);
const hasColoringMock = vi.mocked(reading.bookHasColoring);
const hasActiveColoringMock = vi.mocked(reading.bookHasActiveColoring);
const subscribeMock = vi.mocked(reading.onColoringProgress);

/** The handler `useColoring` subscribed with, so a test can emit progress. */
let push: (progress: reading.ColoringProgress) => void = () => {};

/**
 * The job's strip on its own tile. It is `role="status"` rather than an alert:
 * a background job is not an error, so it must not interrupt a screen reader
 * mid-shelf — but it must be findable.
 */
function jobStrip(tile: HTMLElement) {
  return within(tile).getByRole("status", { name: "着色进度" });
}

/** The header landmark, to prove the job's progress no longer lives there. */
function header() {
  return screen.getByRole("banner");
}

const dune: library.Book = {
  id: "dune",
  title: "Dune",
  authors: ["Frank Herbert"],
  addedAt: 2,
  size: 1024,
  hasCover: false,
};

const emma: library.Book = {
  id: "emma",
  title: "Emma",
  authors: ["Jane Austen"],
  addedAt: 1,
  size: 2048,
  hasCover: false,
};

describe("library", () => {
  beforeEach(() => {
    listMock.mockResolvedValue([]);
    coverMock.mockResolvedValue(null);
    openMock.mockResolvedValue(null);
    saveMock.mockResolvedValue(null);
    exportMock.mockResolvedValue({ colored: 4, chapters: 4, skipped: 0 });
    colorizeMock.mockResolvedValue(undefined);
    cancelMock.mockResolvedValue(undefined);
    progressMock.mockResolvedValue(null);
    hasColoringMock.mockResolvedValue(false);
    hasActiveColoringMock.mockResolvedValue(false);
    subscribeMock.mockImplementation(async (handler) => {
      push = handler;
      return () => {};
    });
  });

  it("shows nothing for a job that was cancelled before the shelf mounted", async () => {
    listMock.mockResolvedValue([dune]);
    progressMock.mockResolvedValue({
      book: "dune",
      done: 120,
      total: 200,
      chapters: 2,
      chaptersTotal: 4,
      finished: true,
      cancelled: true,
      error: null,
    });
    render(<App />);
    await screen.findByText("1 本书");

    // A stop is the user's own news: it leaves no trace on the shelf.
    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    expect(within(tile).queryByRole("status", { name: "着色进度" })).not.toBeInTheDocument();
    expect(within(tile).getByRole("button", { name: "阅读《Dune》" })).toBeEnabled();
  });

  it("offers 着色全书 and shows the progress on its tile", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune, emma]);
    render(<App />);
    await screen.findByText("2 本书");

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    await user.click(within(tile).getByRole("menuitem", { name: "着色全书" }));

    expect(colorizeMock).toHaveBeenCalledWith("dune");
    // Starting is fire-and-forget: the job reports itself, and the shelf cannot
    // know a job exists until it says so.
    await waitFor(() => expect(subscribeMock).toHaveBeenCalled());
    act(() =>
      push({
        book: "dune",
        done: 50,
        total: 200,
        chapters: 0,
        chaptersTotal: 4,
        finished: false,
        cancelled: false,
        error: null,
      }),
    );
    // The job's only trace is the strip on its own tile, never in the header.
    await waitFor(() => expect(jobStrip(tile)).toBeInTheDocument());
    expect(within(header()).queryByRole("status", { name: "着色进度" })).not.toBeInTheDocument();
    expect(jobStrip(tile)).toHaveTextContent("25%");
    // The strip's loader animation is the brand helix. jsdom has no WebGL, so
    // HelixViewer shows its static fallback image; this is the same spot a real
    // WebView renders as the rotating three.js helix, so seeing it proves the
    // helix loader is mounted on the job's strip. It is lazy-loaded, so wait
    // for the chunk.
    await waitFor(() =>
      expect(jobStrip(tile).querySelector('img[src$="helix-launch.svg"]')).not.toBeNull(),
    );
    // A job holds its book: opening it is what the user must not be able to do
    // while the job and the reader would analyze the same chapters.
    expect(within(tile).getByRole("button", { name: "阅读《Dune》" })).toBeDisabled();
    // The other book is untouched: coloring is background work.
    expect(
      within(screen.getByRole("heading", { name: "Emma" }).closest("li")!).getByRole("button", {
        name: "阅读《Emma》",
      }),
    ).toBeEnabled();
  });

  it("shows a running job on a shelf that mounted after it started", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune, emma]);
    // The job was started before this renderer existed (a reload mid-job).
    progressMock.mockResolvedValue({
      book: "dune",
      done: 50,
      total: 200,
      chapters: 1,
      chaptersTotal: 4,
      finished: false,
      cancelled: false,
      error: null,
    });
    render(<App />);
    await screen.findByText("2 本书");

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    expect(jobStrip(tile)).toHaveTextContent("25%");
    expect(within(tile).getByRole("button", { name: "阅读《Dune》" })).toBeDisabled();
    // Cancelling a job the user cannot see the start of is the point of
    // reading it on mount — the strip carries no controls, so the menu does it.
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    await user.click(within(tile).getByRole("menuitem", { name: "取消着色全书" }));
    expect(cancelMock).toHaveBeenCalled();
  });

  it("offers 着色全书 on other books only once the job is over", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune, emma]);
    progressMock.mockResolvedValue({
      book: "dune",
      done: 50,
      total: 200,
      chapters: 1,
      chaptersTotal: 4,
      finished: false,
      cancelled: false,
      error: null,
    });
    render(<App />);
    await screen.findByText("2 本书");

    const other = screen.getByRole("heading", { name: "Emma" }).closest("li")!;
    await user.click(within(other).getByRole("button", { name: "《Emma》的操作" }));
    // One job at a time: a second pass would wait hours behind the first, so
    // the item explains itself instead of starting and being refused.
    expect(within(other).getByRole("menuitem", { name: "着色全书" })).toBeDisabled();
    // Reading needs no menu item: the cover and the title open the book.
    expect(within(other).queryByRole("menuitem", { name: "阅读" })).not.toBeInTheDocument();
  });

  it("a finished job leaves no trace and frees the book", async () => {
    listMock.mockResolvedValue([dune]);
    progressMock.mockResolvedValue({
      book: "dune",
      done: 200,
      total: 200,
      chapters: 4,
      chaptersTotal: 4,
      finished: true,
      cancelled: false,
      error: null,
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("1 本书");

    // Done is not news: the strip is gone without a dismissal, and the book
    // behaves like any other.
    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    expect(within(tile).queryByRole("status", { name: "着色进度" })).not.toBeInTheDocument();
    expect(within(tile).getByRole("button", { name: "阅读《Dune》" })).toBeEnabled();
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    expect(within(tile).getByRole("menuitem", { name: "着色全书" })).toBeEnabled();
  });

  it("the strip disappears the moment a running job finishes", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    render(<App />);
    await screen.findByText("1 本书");

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    await user.click(within(tile).getByRole("menuitem", { name: "着色全书" }));
    act(() =>
      push({
        book: "dune",
        done: 100,
        total: 200,
        chapters: 2,
        chaptersTotal: 4,
        finished: false,
        cancelled: false,
        error: null,
      }),
    );
    await waitFor(() => expect(jobStrip(tile)).toBeInTheDocument());

    act(() =>
      push({
        book: "dune",
        done: 200,
        total: 200,
        chapters: 4,
        chaptersTotal: 4,
        finished: true,
        cancelled: false,
        error: null,
      }),
    );
    await waitFor(() =>
      expect(within(tile).queryByRole("status", { name: "着色进度" })).not.toBeInTheDocument(),
    );
    expect(within(tile).getByRole("button", { name: "阅读《Dune》" })).toBeEnabled();
    expect(within(tile).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says why the job stopped, keeping what it colored", async () => {
    listMock.mockResolvedValue([dune]);
    progressMock.mockResolvedValue({
      book: "dune",
      done: 120,
      total: 200,
      chapters: 2,
      chaptersTotal: 4,
      finished: true,
      cancelled: false,
      error: "models-missing: 尚未下载模型",
    });
    render(<App />);
    await screen.findByText("1 本书");

    // A failure is news, unlike a finish: it becomes an alert, and the strip
    // still disappears.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("着色全书中断");
    expect(alert).toHaveTextContent("尚未下载模型");
    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    expect(within(tile).queryByRole("status", { name: "着色进度" })).not.toBeInTheDocument();
    expect(within(tile).getByRole("button", { name: "阅读《Dune》" })).toBeEnabled();
  });

  it("reports a job that could not start", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    colorizeMock.mockRejectedValue("book-coloring: 这本书已经在着色了");
    render(<App />);
    await screen.findByText("1 本书");

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    await user.click(within(tile).getByRole("menuitem", { name: "着色全书" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("这本书已经在着色了");
    expect(within(tile).queryByRole("status", { name: "着色进度" })).not.toBeInTheDocument();
  });

  it("exports a colored book with inline styles by default", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    saveMock.mockResolvedValue("/books/Dune-colored.epub");
    render(<App />);
    await screen.findByText("1 本书");

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    hasActiveColoringMock.mockResolvedValue(true);
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    // The item greys until the menu's coloring check answers true.
    const exportItem = within(tile).getByRole("menuitem", { name: "导出着色后的图书" });
    await waitFor(() => expect(exportItem).toBeEnabled());
    await user.click(exportItem);
    const dialog = within(tile).getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "导出《Dune》" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "选择位置并导出" }));

    // The save dialog opens on the book's title, so the common case is one
    // keystroke away from a file that names itself.
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Dune.epub" }),
    );
    expect(exportMock).toHaveBeenCalledWith("dune", "/books/Dune-colored.epub", "inline");
    // Which file it went to, because the save dialog may have opened in a
    // folder the user was not looking at.
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "已导出到 Dune-colored.epub",
    );
    expect(within(dialog).getByText("4 章全部带上颜色。")).toBeInTheDocument();
  });

  it("exports the stylesheet as its own file when asked to", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    saveMock.mockResolvedValue("/books/Dune.epub");
    render(<App />);
    await screen.findByText("1 本书");

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    hasActiveColoringMock.mockResolvedValue(true);
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    // The item greys until the menu's coloring check answers true.
    const exportItem = within(tile).getByRole("menuitem", { name: "导出着色后的图书" });
    await waitFor(() => expect(exportItem).toBeEnabled());
    await user.click(exportItem);
    const dialog = within(tile).getByRole("dialog");

    await user.click(within(dialog).getByRole("radio", { name: /外联/ }));
    await user.click(within(dialog).getByRole("button", { name: "选择位置并导出" }));

    expect(exportMock).toHaveBeenCalledWith("dune", "/books/Dune.epub", "external");
  });

  it("does nothing when the save dialog is cancelled", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    render(<App />);
    await screen.findByText("1 本书");

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    hasActiveColoringMock.mockResolvedValue(true);
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    // The item greys until the menu's coloring check answers true.
    const exportItem = within(tile).getByRole("menuitem", { name: "导出着色后的图书" });
    await waitFor(() => expect(exportItem).toBeEnabled());
    await user.click(exportItem);
    const dialog = within(tile).getByRole("dialog");

    // No destination, no export: the dialog stays up, ready for another try.
    await user.click(within(dialog).getByRole("button", { name: "选择位置并导出" }));

    expect(exportMock).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "选择位置并导出" })).toBeEnabled();
  });

  it("says which chapters of a half-colored book stayed plain", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    saveMock.mockResolvedValue("/books/Dune.epub");
    exportMock.mockResolvedValue({ colored: 2, chapters: 4, skipped: 2 });
    render(<App />);
    await screen.findByText("1 本书");

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    hasActiveColoringMock.mockResolvedValue(true);
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    // The item greys until the menu's coloring check answers true.
    const exportItem = within(tile).getByRole("menuitem", { name: "导出着色后的图书" });
    await waitFor(() => expect(exportItem).toBeEnabled());
    await user.click(exportItem);
    const dialog = within(tile).getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "选择位置并导出" }));

    expect(
      await within(dialog).findByText("2 章带上了颜色，2 章还没有着色，保持原样。"),
    ).toBeInTheDocument();
  });

  it("reports a failed export and keeps the choices on screen", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    saveMock.mockResolvedValue("/books/Dune.epub");
    exportMock.mockRejectedValue("无法写入 /books/Dune.epub：磁盘已满");
    render(<App />);
    await screen.findByText("1 本书");

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    hasActiveColoringMock.mockResolvedValue(true);
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    // The item greys until the menu's coloring check answers true.
    const exportItem = within(tile).getByRole("menuitem", { name: "导出着色后的图书" });
    await waitFor(() => expect(exportItem).toBeEnabled());
    await user.click(exportItem);
    const dialog = within(tile).getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "选择位置并导出" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("磁盘已满");
    // The reason stays next to the button that can retry.
    expect(within(dialog).getByRole("button", { name: "选择位置并导出" })).toBeEnabled();
  });

  it("will not export the book it is coloring", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    // The book has coloring: the grey must come from the running job, not
    // from an empty cache.
    hasActiveColoringMock.mockResolvedValue(true);
    progressMock.mockResolvedValue({
      book: "dune",
      done: 50,
      total: 200,
      chapters: 1,
      chaptersTotal: 4,
      finished: false,
      cancelled: false,
      error: null,
    });
    render(<App />);
    await screen.findByText("1 本书");

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    // The job owns the book: exporting now would write the chapter it is in
    // the middle of analyzing as a plain chapter.
    expect(within(tile).getByRole("menuitem", { name: "导出着色后的图书" })).toBeDisabled();
  });

  it("shows the empty shelf, then the imported book", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("书架还是空的")).toBeInTheDocument();
    expect(screen.getByText("还没有书")).toBeInTheDocument();

    openMock.mockResolvedValue("/books/dune.epub");
    importMock.mockResolvedValue({ library: [dune], added: [dune], errors: [] });

    await user.click(screen.getByRole("button", { name: "选择 EPUB 文件" }));

    const tile = (await screen.findByRole("heading", { name: "Dune" })).closest("li")!;
    expect(within(tile).getByText("Frank Herbert")).toBeInTheDocument();
    expect(screen.getByText("1 本书")).toBeInTheDocument();
    expect(screen.queryByText("书架还是空的")).not.toBeInTheDocument();
    expect(importMock).toHaveBeenCalledWith(["/books/dune.epub"]);
  });

  it("does nothing when the picker is cancelled", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("书架还是空的");

    await user.click(screen.getByRole("button", { name: "添加书籍" }));

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(importMock).not.toHaveBeenCalled();
    expect(screen.getByText("书架还是空的")).toBeInTheDocument();
  });

  it("reports files that could not be imported", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("书架还是空的");

    openMock.mockResolvedValue(["/books/bad.pdf"]);
    importMock.mockResolvedValue({
      library: [],
      added: [],
      errors: [{ name: "bad.pdf", message: "not an EPUB file: invalid archive" }],
    });

    await user.click(screen.getByRole("button", { name: "添加书籍" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("无法添加 bad.pdf")).toBeInTheDocument();
    expect(within(alert).getByText(/bad.pdf: not an EPUB file: invalid archive/)).toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("removes a book from the shelf", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune, emma]);
    removeMock.mockResolvedValue([emma]);
    render(<App />);

    expect(await screen.findByText("2 本书")).toBeInTheDocument();

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    await user.click(within(tile).getByRole("menuitem", { name: "从书架移除" }));
    await user.click(screen.getByRole("button", { name: "移除" }));

    expect(removeMock).toHaveBeenCalledWith("dune");
    await waitFor(() => expect(screen.queryByText("Dune")).not.toBeInTheDocument());
    expect(screen.getByText("1 本书")).toBeInTheDocument();
  });

  it("greys out 导出着色后的图书 while the book has no coloring to export", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    render(<App />);
    await screen.findByText("1 本书");

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    // The answer, not the pending state, is what must grey the item: wait for
    // the check to have run before asserting.
    await waitFor(() => expect(hasActiveColoringMock).toHaveBeenCalledWith("dune"));
    const item = within(tile).getByRole("menuitem", { name: "导出着色后的图书" });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", "还没有着色，先着色全书再导出");
  });

  it("greys out 清除着色缓存 while the book has no coloring", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    render(<App />);
    await screen.findByText("1 本书");

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    // The answer, not the pending state, is what must grey the item: wait for
    // the check to have run before asserting.
    await waitFor(() => expect(hasColoringMock).toHaveBeenCalledWith("dune"));
    const item = within(tile).getByRole("menuitem", { name: "清除着色缓存" });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", "还没有着色缓存");
    expect(clearCacheMock).not.toHaveBeenCalled();
  });

  it("clears a book's coloring cache after asking", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune, emma]);
    hasColoringMock.mockResolvedValue(true);
    render(<App />);
    expect(await screen.findByText("2 本书")).toBeInTheDocument();

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    const item = within(tile).getByRole("menuitem", { name: "清除着色缓存" });
    await waitFor(() => expect(item).toBeEnabled());
    await user.click(item);
    // The dialog names the book, or a click meant for another tile could
    // clear the wrong one's work.
    expect(screen.getByRole("heading", { name: "清除《Dune》的着色缓存？" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除" }));

    expect(clearCacheMock).toHaveBeenCalledWith("dune");
    // The cache is invisible: a success keeps the shelf as it was and quiet.
    expect(await screen.findByText("2 本书")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears the pending tile and reports an unexpected import failure", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("书架还是空的");

    openMock.mockResolvedValue(["/books/dune.epub", "/books/emma.epub"]);
    importMock.mockRejectedValue("Cannot reach the library on disk");

    await user.click(screen.getByRole("button", { name: "添加书籍" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("出了点问题")).toBeInTheDocument();
    expect(within(alert).getByText("Cannot reach the library on disk")).toBeInTheDocument();
    // The pending tiles clear out; the two skeleton boxes the closed-but-mounted
    // model sheet keeps are ignored (jsdom has no `:where(dialog:not([open]))`).
    expect(document.querySelectorAll("li[aria-hidden='true'] .skeleton")).toHaveLength(0);
  });

  it("shows a placeholder when a cover image fails to decode", async () => {
    listMock.mockResolvedValue([{ ...dune, hasCover: true }]);
    coverMock.mockResolvedValue({ mime: "image/png", base64: "bm90IGFuIGltYWdl" });
    render(<App />);

    const image = await screen.findByRole("presentation", { hidden: true });
    expect(image).toHaveAttribute("src", "data:image/png;base64,bm90IGFuIGltYWdl");

    fireEvent.error(image);

    await waitFor(() =>
      expect(screen.queryByRole("presentation", { hidden: true })).not.toBeInTheDocument(),
    );
  });

  it("does not resurrect a book when an older import finishes later", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    render(<App />);
    await screen.findByText("1 本书");

    // The import is still running when the book is removed.
    let finishImport: (report: library.ImportReport) => void = () => {};
    openMock.mockResolvedValue("/books/emma.epub");
    importMock.mockReturnValue(
      new Promise<library.ImportReport>((resolve) => {
        finishImport = resolve;
      }),
    );
    const add = screen.getByRole("button", { name: "添加书籍" });
    await user.click(add);
    await waitFor(() => expect(importMock).toHaveBeenCalled());

    removeMock.mockResolvedValue([]);
    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    await user.click(within(tile).getByRole("menuitem", { name: "从书架移除" }));
    await user.click(screen.getByRole("button", { name: "移除" }));
    // The tile disappears immediately, before any command has resolved.
    await waitFor(() => expect(screen.getByText("还没有书")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Dune" })).not.toBeInTheDocument();

    // A stale snapshot from the import must not overwrite the newer removal.
    finishImport({ library: [dune], added: [dune], errors: [] });
    await waitFor(() =>
      expect(document.querySelectorAll("li[aria-hidden='true'] .skeleton")).toHaveLength(0),
    );
    expect(screen.getByText("还没有书")).toBeInTheDocument();
  });

  it("shows a book again when the user re-adds it after removing it", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    render(<App />);
    await screen.findByText("1 本书");

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    await user.click(within(tile).getByRole("menuitem", { name: "从书架移除" }));
    await user.click(screen.getByRole("button", { name: "移除" }));
    await waitFor(() => expect(screen.getByText("还没有书")).toBeInTheDocument());

    // Importing the same file again must show it, despite the earlier removal.
    openMock.mockResolvedValue("/books/dune.epub");
    importMock.mockResolvedValue({ library: [dune], added: [dune], errors: [] });
    await user.click(screen.getByRole("button", { name: "添加书籍" }));

    expect(await screen.findByRole("heading", { name: "Dune" })).toBeInTheDocument();
  });

  it("runs a removal after the import that was already in flight", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    render(<App />);
    await screen.findByText("1 本书");

    // The import is still copying when the user removes the book.
    let finishImport: (report: library.ImportReport) => void = () => {};
    openMock.mockResolvedValue("/books/dune.epub");
    importMock.mockReturnValue(
      new Promise<library.ImportReport>((resolve) => {
        finishImport = resolve;
      }),
    );
    await user.click(screen.getByRole("button", { name: "添加书籍" }));
    await waitFor(() => expect(importMock).toHaveBeenCalled());

    removeMock.mockResolvedValue([]);
    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    await user.click(within(tile).getByRole("menuitem", { name: "从书架移除" }));
    await user.click(screen.getByRole("button", { name: "移除" }));
    await waitFor(() => expect(screen.getByText("还没有书")).toBeInTheDocument());

    // The removal waits for the import, so it is the last word on the shelf.
    expect(removeMock).not.toHaveBeenCalled();
    finishImport({ library: [dune], added: [dune], errors: [] });
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("dune"));
    await waitFor(() =>
      expect(document.querySelectorAll("li[aria-hidden='true'] .skeleton")).toHaveLength(0),
    );
    expect(screen.queryByRole("heading", { name: "Dune" })).not.toBeInTheDocument();
  });

  it("puts the book back when the removal fails", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    render(<App />);
    await screen.findByText("1 本书");

    removeMock.mockRejectedValue("the disk is read only");
    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "《Dune》的操作" }));
    await user.click(within(tile).getByRole("menuitem", { name: "从书架移除" }));
    await user.click(screen.getByRole("button", { name: "移除" }));

    expect(await screen.findByText("the disk is read only")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Dune" })).toBeInTheDocument();
    expect(screen.getByText("1 本书")).toBeInTheDocument();
  });

  it("adds up the failures of overlapping imports", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("书架还是空的");

    const failures: library.ImportReport[] = [
      { library: [], added: [], errors: [{ name: "a.pdf", message: "not an EPUB file" }] },
      { library: [], added: [], errors: [{ name: "b.pdf", message: "not an EPUB file" }] },
    ];
    openMock.mockResolvedValue("/books/a.epub");
    let call = 0;
    importMock.mockImplementation(async () => failures[call++]);

    const add = screen.getByRole("button", { name: "添加书籍" });
    await user.click(add);
    await user.click(add);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(/a\.pdf: not an EPUB file/)).toBeInTheDocument();
    expect(within(alert).getByText(/b\.pdf: not an EPUB file/)).toBeInTheDocument();
  });

  it("loads covers only for books that have one", async () => {
    listMock.mockResolvedValue([dune, { ...emma, hasCover: true }]);
    coverMock.mockResolvedValue({ mime: "image/png", base64: "cG5n" });
    render(<App />);

    await screen.findByText("2 本书");
    await waitFor(() => expect(coverMock).toHaveBeenCalledTimes(1));
    expect(coverMock).toHaveBeenCalledWith("emma");

    const image = screen.getByRole("presentation", { hidden: true });
    expect(image).toHaveAttribute("src", "data:image/png;base64,cG5n");
  });
});
