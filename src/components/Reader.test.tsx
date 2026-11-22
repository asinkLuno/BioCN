/**
 * Reader behavior against the new architecture: foliate as parser only, the
 * chapter document rendered into a srcdoc iframe. The parser and the asset
 * fetch are mocked at module boundaries; everything between open → chapter →
 * rendered iframe is real.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Reader } from "./Reader";
import * as reading from "../lib/reading";
import * as epub from "../lib/epub";
import { paintChapter } from "../lib/overlay";

vi.mock("../lib/reading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/reading")>()),
  bookOpen: vi.fn(),
  bookChapter: vi.fn(),
}));

vi.mock("../lib/epub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/epub")>()),
  openBook: vi.fn(),
  fetchBookBlob: vi.fn(),
}));

const openMock = vi.mocked(reading.bookOpen);
const chapterMock = vi.mocked(reading.bookChapter);
const openBookMock = vi.mocked(epub.openBook);
const fetchBlobMock = vi.mocked(epub.fetchBookBlob);

/** A fake parsed book: sections load lazily, one Document per call. */
/**
 * A fake parsed book: sections return blob: URLs (what foliate's `load()`
 * really does), and a stubbed `fetch` resolves them back to the document
 * HTML — same shape as the real loader's resource-rewritten blob.
 */
function fakeBook(sectionDocs: (string | null)[]) {
  const created: Document[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const doc = created.find((d) => `blob:${d.URL}` === url);
      if (!doc) throw new Error(`no document for ${url}`);
      return {
        ok: true,
        text: async () => `<!DOCTYPE html>${doc.documentElement.outerHTML}`,
      };
    }),
  );
  return {
    created,
    book: {
      sections: sectionDocs.map((src) => ({
        linear: "yes",
        size: 0,
        load: async () => {
          if (src === null) return null;
          const doc = new DOMParser().parseFromString(
            `<html><head><title>t</title></head><body>${src}</body></html>`,
            "text/html",
          );
          created.push(doc);
          return `blob:${doc.URL}`;
        },
        unload: () => {},
      })),
      toc: [],
      resolveHref: () => null,
      isExternal: () => false,
      destroy: () => {},
    },
  };
}

const book: reading.BookView = {
  id: "dune",
  // The stored file must exist for the reader to even parse the book; the seam
  // under test here is parse+render, so a path belongs in the happy fixture.
  filePath: "dune.epub",
  title: "Dune",
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
  beforeEach(() => {
    openMock.mockResolvedValue(book);
    openBookMock.mockResolvedValue(fakeBook([null, "<p>他走了。</p>", "<p>再会。</p>"]).book);
    fetchBlobMock.mockResolvedValue(new File(["PK"], "book.epub"));
    chapterMock.mockResolvedValue(chapter);
  });

  it("renders the colored chapter document into the iframe", async () => {
    renderReader();
    const frame = await screen.findByTitle("One");
    // jsdom does not load srcdoc documents, so the contract is checked on the
    // attribute: React must pass the full serialized chapter through. What
    // that document contains is pinned by lib/overlay.test.ts and below.
    const srcdoc = frame.getAttribute("srcdoc");
    expect(srcdoc).toContain("<!DOCTYPE html>");
    // Coloring splits the sentence into spans, so the text never appears
    // contiguous — the pieces and their spans are the contract.
    expect(srcdoc).toContain(">他</span>");
    expect(srcdoc).toContain(">走</span>");
    expect(srcdoc).toContain("了。</p>");
  });

  it("colors subjects and predicates inside the document", async () => {
    renderReader();
    const frame = await screen.findByTitle("One");
    const doc = new DOMParser().parseFromString(
      frame.getAttribute("srcdoc")!,
      "text/html",
    );
    // The parsed doc is detached from the jsdom tree, so jest-dom matchers
    // that need a live document are out — plain textContent checks instead.
    expect(doc.querySelector(".svo-subject")?.textContent).toBe("他");
    expect(doc.querySelector(".svo-predicate")?.textContent).toBe("走");
    expect(doc.querySelectorAll(".svo")).toHaveLength(2);
  });

  it("opens at the first chapter that has text", async () => {
    renderReader();
    await screen.findByTitle("One");
    // Chapter 0 is a cover page with no prose, so chapter 1 is what opens.
    expect(chapterMock).toHaveBeenCalledWith("dune", 1);
    // The counter is the spine position: a cover page still occupies slot one.
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("offers settings instead of a raw error when no model is installed", async () => {
    const onOpenSettings = vi.fn();
    chapterMock.mockRejectedValue(
      `${reading.MODEL_MISSING}: 尚未下载模型（设置 → 分析模型）`,
    );
    renderReader({ onOpenSettings });
    const user = userEvent.setup();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/需要分析模型/)).toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "打开设置" }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("retries the chapter after settings closes", async () => {
    chapterMock.mockRejectedValueOnce(
      `${reading.MODEL_MISSING}: 尚未下载模型（设置 → 分析模型）`,
    );
    const { rerender } = render(
      <Reader id="dune" onClose={() => {}} onOpenSettings={() => {}} modelsOpen={false} />,
    );
    await screen.findByRole("alert");

    rerender(
      <Reader id="dune" onClose={() => {}} onOpenSettings={() => {}} modelsOpen />,
    );
    rerender(
      <Reader id="dune" onClose={() => {}} onOpenSettings={() => {}} modelsOpen={false} />,
    );
    // The model was just downloaded, so the page must come back on its own.
    await screen.findByTitle("One");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not ask the new book for the old book's chapter number", async () => {
    const { rerender } = renderReader();
    await screen.findByTitle("One");
    expect(chapterMock).toHaveBeenCalledWith("dune", 1);

    const second = fakeBook([null, null, null, null, null, null, null, "<p>七</p>"]);
    openMock.mockResolvedValue({
      id: "emma",
      filePath: "emma.epub",
      title: "Emma",
      chapters: [
        { index: 0, title: null, paragraphs: 0 },
        { index: 7, title: "Seven", paragraphs: 1 },
      ],
    });
    openBookMock.mockResolvedValue(second.book);
    chapterMock.mockClear();
    rerender(
      <Reader id="emma" onClose={() => {}} onOpenSettings={() => {}} modelsOpen={false} />,
    );

    await waitFor(() => expect(chapterMock).toHaveBeenCalledWith("emma", 7));
    expect(chapterMock).not.toHaveBeenCalledWith("emma", 1);
    expect(screen.queryByText(/无法打开这一章/)).not.toBeInTheDocument();
  });

  it("lists every spine document, including ones with no text", async () => {
    const user = userEvent.setup();
    renderReader();
    await screen.findByTitle("One");

    await user.click(screen.getByRole("button", { name: "目录" }));
    const nav = screen.getByRole("navigation", { name: "章节目录" });
    expect(within(nav).getAllByRole("button")).toHaveLength(3);
    expect(within(nav).getByText("无正文")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /第 0 节/ })).toBeDisabled();
  });

  it("turns pages with the arrow keys and stops at the ends", async () => {
    renderReader();
    await screen.findByTitle("One");

    chapterMock.mockResolvedValue({ ...chapter, index: 2, title: "Two" });
    await userEvent.keyboard("{ArrowRight}");
    await screen.findByTitle("Two");

    // Chapter 2 is the last one: the right arrow must not wrap or overshoot.
    chapterMock.mockClear();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(chapterMock).not.toHaveBeenCalled());
    expect(screen.queryByTitle(/第/)).not.toBeInTheDocument();
  });

  it("paints only what matches: overlay stays honest on a foreign doc", () => {
    // A document whose text does not match the analyzer's paragraphs must be
    // left uncolored — a missing color is fine, a wrong one is not.
    const doc = new DOMParser().parseFromString(
      "<html><body><p>完全无关的文本。</p></body></html>",
      "text/html",
    );
    const stats = paintChapter(doc, chapter.paragraphs);
    expect(stats.painted).toBe(0);
    expect(doc.querySelector(".svo")).toBeNull();
    expect(doc.querySelector("body")?.textContent).toContain("完全无关的文本。");
  });
});
