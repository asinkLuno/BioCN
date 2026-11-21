import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Reader } from "./Reader";
import * as reading from "../lib/reading";
import * as foliate from "../lib/foliate";

vi.mock("../lib/reading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/reading")>()),
  bookOpen: vi.fn(),
  bookChapter: vi.fn(),
}));

vi.mock("../lib/foliate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/foliate")>()),
  fetchBookBlob: vi.fn(),
  // The real foliate-js needs a WebView (iframes, ResizeObserver); the seam
  // module is the boundary, so the fake view drives the same handlers the
  // real one would — and the real overlay paints into the fake's documents.
  createBookView: vi.fn(),
}));

const openMock = vi.mocked(reading.bookOpen);
const chapterMock = vi.mocked(reading.bookChapter);
const blobMock = vi.mocked(foliate.fetchBookBlob);
const createViewMock = vi.mocked(foliate.createBookView);

const book: reading.BookView = {
  id: "dune",
  title: "Dune",
  filePath: "/books/dune.epub",
  chapters: [
    { index: 0, title: null, paragraphs: 0 },
    { index: 1, title: "One", paragraphs: 2 },
    { index: 2, title: "Two", paragraphs: 1 },
  ],
};

const chapter: reading.ChapterView = {
  index: 1,
  title: "One",
  paragraphs: [
    // The document title is paragraph zero: the parser walks the whole
    // document, so the head's <title> lands before the prose.
    { text: "One", sentences: [] },
    {
      text: "他走了。",
      sentences: [
        {
          text: "他走了。",
          start: 0,
          segments: [
            { text: "他", start: 0, role: "subject" },
            { text: "走", start: 1, role: "predicate" },
            { text: "了。", start: 2, role: "normal" },
          ],
        },
      ],
    },
  ],
};

/**
 * The fake foliate view renders each section as a real detached document, so
 * the overlay's painting runs for real and the tests can assert on its spans.
 */
const titles = ["封面", "One", "Two"];
const docs = new Map<number, Document>();

const buildDoc = (index: number) =>
  new DOMParser().parseFromString(
    `<html><head><title>${sectionTitle(index)}</title></head><body><p>他走了。</p></body></html>`,
    "text/html",
  );

/** Titles beyond the fixture (a rerendered book's chapters) are synthesized. */
const sectionTitle = (index: number) => titles[index] ?? `第 ${index} 节`;

function rebuildDocs() {
  docs.clear();
  for (let index = 0; index < titles.length; index++) {
    docs.set(index, buildDoc(index));
  }
}

interface FakeView {
  goTo: (index: number) => Promise<unknown>;
  close: ReturnType<typeof vi.fn>;
}

const views: FakeView[] = [];
let handlers: Parameters<typeof foliate.createBookView>[1] | null = null;

beforeEach(() => {
  openMock.mockResolvedValue(book);
  rebuildDocs();
  chapterMock.mockImplementation((_id: string, index: number) =>
    Promise.resolve({
      ...chapter,
      index,
      title: index === 1 ? "One" : sectionTitle(index),
      paragraphs:
        index === 1
          ? chapter.paragraphs
          : [
              { text: sectionTitle(index), sentences: [] },
              { text: "他走了。", sentences: chapter.paragraphs[1].sentences },
            ],
    }),
  );
  blobMock.mockResolvedValue(new File(["fake epub"], "book.epub", { type: "application/epub+zip" }));
  views.length = 0;
  createViewMock.mockImplementation(async (_blob, passed) => {
    handlers = passed;
    // The reader appends the returned element to its host and later removes
    // it, so the fake must be a real Node — exactly what `foliate-view` is.
    const view = document.createElement("div") as unknown as HTMLDivElement & FakeView;
    Object.assign(view, {
      goTo: vi.fn(async (index: number) => {
        // foliate fires `load` when the section document arrives and
        // `relocate` once it is anchored — in that order.
        const doc = docs.get(index) ?? buildDoc(index);
        handlers?.onLoad({ doc, index });
        handlers?.onRelocate({
          index,
          fraction: 0,
          section: { current: index + 1, total: book.chapters.length },
          tocItem: null,
          cfi: "",
        });
        return { index, anchor: null };
      }),
      close: vi.fn(),
      renderer: { setAttribute: vi.fn(), setStyles: vi.fn(), getContents: () => [] },
      book: {
        sections: [],
        toc: [
          { label: "封面", href: "cover.xhtml" },
          { label: "One", href: "c1.xhtml" },
          { label: "Two", href: "c2.xhtml" },
        ],
        resolveHref: (href: string) => {
          const index = { "cover.xhtml": 0, "c1.xhtml": 1, "c2.xhtml": 2 }[href];
          return index === undefined ? null : { index, anchor: null };
        },
        isExternal: () => false,
      },
    });
    views.push(view);
    return view as unknown as Awaited<ReturnType<typeof foliate.createBookView>>;
  });
});

/** The overlay paints into the fake view's document, not the React tree. */
async function subjectSpan(index = 1) {
  return waitFor(() => {
    const span = docs.get(index)!.querySelector(".svo-subject");
    expect(span).not.toBeNull();
    return span!;
  });
}

function renderReader(overrides: Partial<Parameters<typeof Reader>[0]> = {}) {
  return render(
    <Reader
      id="dune"
      onClose={() => {}}
      onOpenSettings={() => {}}
      modelsOpen={false}
      {...overrides}
    />,
  );
}

describe("reader", () => {
  it("opens at the first chapter that has text", async () => {
    renderReader();
    // Chapter 0 is a cover page with no prose, so chapter 1 is what opens.
    await subjectSpan();
    expect(views[0]?.goTo).toHaveBeenCalledWith(1);
    await waitFor(() => expect(chapterMock).toHaveBeenCalledWith("dune", 1));
    // The counter is the spine position, not the index among readable
    // chapters: a book's cover page still occupies slot one.
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    // The loading skeleton is gone once the first section is anchored.
    expect(document.querySelector(".skeleton")).toBeNull();
  });

  it("colors subjects and predicates in the book's own markup", async () => {
    renderReader();
    const span = await subjectSpan();
    // Plain textContent, not jest-dom matchers: the painted document belongs
    // to DOMParser, which has no defaultView, and jest-dom's node check
    // requires one.
    expect(span.textContent).toBe("他");
    const doc = docs.get(1)!;
    expect(doc.querySelector(".svo-predicate")?.textContent).toBe("走");
    // The book's paragraph keeps its text and structure while spans go in.
    expect(doc.querySelector("p")?.textContent).toBe("他走了。");
  });

  it("offers settings instead of a raw error when no model is installed", async () => {
    const onOpenSettings = vi.fn();
    chapterMock.mockRejectedValue(
      `${reading.MODEL_MISSING}: 尚未下载模型（设置 → 分析模型）`,
    );
    renderReader({ onOpenSettings });
    const user = userEvent.setup();

    // The book itself still renders; the alert rides above it.
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/需要分析模型/)).toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "打开设置" }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("retries the section after settings closes", async () => {
    chapterMock.mockRejectedValueOnce(
      `${reading.MODEL_MISSING}: 尚未下载模型（设置 → 分析模型）`,
    );
    const { rerender } = renderReader();
    await screen.findByRole("alert");

    rerender(
      <Reader
        id="dune"
        onClose={() => {}}
        onOpenSettings={() => {}}
        modelsOpen
      />,
    );
    rerender(
      <Reader
        id="dune"
        onClose={() => {}}
        onOpenSettings={() => {}}
        modelsOpen={false}
      />,
    );
    // The model was just downloaded, so the page must come back on its own.
    await subjectSpan();
  });

  it("does not ask the new book for the old book's chapter number", async () => {
    const { rerender } = renderReader();
    await subjectSpan();
    await waitFor(() => expect(chapterMock).toHaveBeenCalledWith("dune", 1));

    // The second book's readable chapter is number 7 — not 1, which is where
    // the previous book was left. Asking for it would flash "no chapter 1".
    const other: reading.BookView = {
      id: "emma",
      title: "Emma",
      filePath: "/books/emma.epub",
      chapters: [
        { index: 0, title: null, paragraphs: 0 },
        { index: 7, title: "Seven", paragraphs: 1 },
      ],
    };
    openMock.mockResolvedValue(other);
    chapterMock.mockClear();
    rerender(
      <Reader
        id="emma"
        onClose={() => {}}
        onOpenSettings={() => {}}
        modelsOpen={false}
      />,
    );

    await waitFor(() => expect(chapterMock).toHaveBeenCalledWith("emma", 7));
    expect(chapterMock).not.toHaveBeenCalledWith("emma", 1);
    expect(screen.queryByText(/无法为这一章着色/)).not.toBeInTheDocument();
  });

  it("shows the book's own table of contents with nesting and badges", async () => {
    const user = userEvent.setup();
    renderReader();
    await subjectSpan();

    await user.click(screen.getByRole("button", { name: "目录" }));
    const nav = screen.getByRole("navigation", { name: "章节目录" });
    // The real TOC of the fake book, flattened by the real flattenToc.
    const rows = within(nav).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      "封面无正文",
      "One",
      "Two",
    ]);
    // Clicking an entry navigates by spine index.
    await user.click(within(nav).getByRole("button", { name: "Two" }));
    await waitFor(() => expect(chapterMock).toHaveBeenCalledWith("dune", 2));
    // The menu closes after following an entry.
    expect(screen.queryByRole("navigation", { name: "章节目录" })).toBeNull();
  });

  it("turns chapters with the arrow keys and stops at the ends", async () => {
    renderReader();
    await subjectSpan();

    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(chapterMock).toHaveBeenCalledWith("dune", 2));

    chapterMock.mockClear();
    // Chapter 2 is the last one: the right arrow must not wrap or overshoot.
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(chapterMock).not.toHaveBeenCalled());
  });

  it("shows a fatal alert when the book itself cannot be opened", async () => {
    blobMock.mockRejectedValue(new Error("无法读取书文件（404）"));
    renderReader();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/无法打开这本书/)).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "返回书架" })).toBeInTheDocument();
  });

  it("closes the foliate view when the reader unmounts", async () => {
    const { unmount } = renderReader();
    await subjectSpan();
    unmount();
    expect(views[0]?.close).toHaveBeenCalled();
  });
});
