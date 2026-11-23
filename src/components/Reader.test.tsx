/**
 * Reader behavior against the `book://` custom protocol + progressive coloring
 * + iframe postMessage bridge architecture.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
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
const openUrlMock = vi.mocked(openUrl);

let emitPatch: (patch: reading.ChapterColorPatch) => void = () => {};

const sampleBook: reading.BookView = {
  id: "dune",
  title: "Dune",
  hasModel: true,
  initialChapter: 1,
  progress: null,
  chapters: [
    { index: 0, manifestId: "cover", href: "OEBPS/Text/cover.xhtml", title: null, colored: true },
    { index: 1, manifestId: "part-1", href: "OEBPS/Text/ch1.xhtml", title: "One", colored: false },
    { index: 2, manifestId: "part-2", href: "OEBPS/Text/ch2.xhtml", title: "Two", colored: false },
  ],
  toc: [
    {
      label: "第一章",
      chapterIndex: 1,
      anchor: null,
      subitems: [{ label: "第一节", chapterIndex: 1, anchor: "s1", subitems: [] }],
    },
    { label: "第二章", chapterIndex: 2, anchor: null, subitems: [] },
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

function sendFromFrame(frame: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow }));
}

describe("reader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    openMock.mockResolvedValue(sampleBook);
    colorizeMock.mockResolvedValue({
      index: 1,
      totalSentences: 10,
      cachedSentences: 10,
      fullyColored: true,
      missingModel: false,
    });
    prefetchMock.mockResolvedValue(undefined);
    cancelStreamMock.mockResolvedValue(undefined);
    progressSaveMock.mockResolvedValue(undefined);
    onPatchMock.mockImplementation(async (handler) => {
      emitPatch = handler;
      return () => {};
    });
  });

  it("opens directly at initialChapter via book:// URL without frontend EPUB parsing", async () => {
    renderReader();
    const frame = (await screen.findByTitle("One")) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toMatch(
      /^book:\/\/localhost\/dune\/OEBPS\/Text\/ch1\.xhtml\?theme=auto&mode=scrolled/,
    );
    expect(colorizeMock).toHaveBeenCalledWith("dune", 1);
    expect(screen.getByText(/2\/3 章/)).toBeInTheDocument();
  });

  it("keeps reading open when no model is installed and offers a non-blocking settings pill", async () => {
    const onOpenSettings = vi.fn();
    colorizeMock.mockResolvedValue({
      index: 1,
      totalSentences: 10,
      cachedSentences: 0,
      fullyColored: false,
      missingModel: true,
    });
    renderReader({ onOpenSettings });
    const frame = await screen.findByTitle("One");
    expect(frame.getAttribute("src")).toMatch(
      /^book:\/\/localhost\/dune\/OEBPS\/Text\/ch1\.xhtml\?/,
    );

    const prompt = await screen.findByRole("button", { name: "下载模型以启用着色" });
    await userEvent.click(prompt);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("buffers progressive color patches before iframe ready and flushes them on ready", async () => {
    colorizeMock.mockResolvedValue({
      index: 1,
      totalSentences: 10,
      cachedSentences: 0,
      fullyColored: false,
      missingModel: false,
    });
    renderReader();
    const frame = (await screen.findByTitle("One")) as HTMLIFrameElement;
    const postSpy = vi.spyOn(frame.contentWindow!, "postMessage");

    await waitFor(() => expect(onPatchMock).toHaveBeenCalled());
    act(() => {
      emitPatch({
        book: "dune",
        chapter: 1,
        done: 5,
        total: 10,
        finished: false,
        missingModel: false,
        error: null,
        patches: [{ key: "0-0", html: '<span class="svo svo-subject">他</span>' }],
      });
    });

    expect(screen.getByRole("status", { name: "本章着色进度" })).toHaveTextContent("着色 50%");
    expect(postSpy).not.toHaveBeenCalled();

    // Once the iframe signals ready, init + queued patches are delivered.
    act(() => sendFromFrame(frame, { source: "biocn-reader", type: "ready" }));
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({ source: "biocn-host", type: "init" }),
      "*",
    );
    expect(postSpy).toHaveBeenCalledWith(
      {
        source: "biocn-host",
        type: "patch",
        patches: [{ key: "0-0", html: '<span class="svo svo-subject">他</span>' }],
      },
      "*",
    );
  });

  it("toggles SVO coloring and appearance preferences live via postMessage", async () => {
    const user = userEvent.setup();
    renderReader();
    const frame = (await screen.findByTitle("One")) as HTMLIFrameElement;
    const postSpy = vi.spyOn(frame.contentWindow!, "postMessage");
    act(() => sendFromFrame(frame, { source: "biocn-reader", type: "ready" }));
    postSpy.mockClear();

    const toggleBtn = screen.getByRole("button", { name: "着色" });
    expect(toggleBtn).toHaveAttribute("aria-pressed", "true");
    await user.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute("aria-pressed", "false");
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "biocn-host",
        type: "prefs",
        prefs: expect.objectContaining({ coloringEnabled: false }),
      }),
      "*",
    );

    await user.click(screen.getByRole("button", { name: "阅读设置" }));
    await user.click(screen.getByRole("button", { name: "分页" }));
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "biocn-host",
        type: "prefs",
        prefs: expect.objectContaining({ viewMode: "paginated" }),
      }),
      "*",
    );
    expect(screen.getByRole("button", { name: "下一页" })).toBeInTheDocument();
  });

  it("navigates via nested TOC drawer and handles internal & external links from iframe", async () => {
    const user = userEvent.setup();
    renderReader();
    const frame = (await screen.findByTitle("One")) as HTMLIFrameElement;
    act(() => sendFromFrame(frame, { source: "biocn-reader", type: "ready" }));

    // Open TOC drawer and jump to chapter 2.
    await user.click(screen.getByRole("button", { name: "目录" }));
    const nav = screen.getByRole("navigation", { name: "章节目录" });
    await user.click(within(nav).getByRole("button", { name: "第二章" }));

    // Double-buffered swap: chapter 1 stays visible until chapter 2 paints!
    const ch2Frame = (await screen.findByTitle("Two")) as HTMLIFrameElement;
    expect(ch2Frame.getAttribute("src")).toMatch(
      /^book:\/\/localhost\/dune\/OEBPS\/Text\/ch2\.xhtml\?/,
    );
    expect(frame).toHaveAttribute("aria-hidden", "false");
    expect(ch2Frame).toHaveAttribute("aria-hidden", "true");

    act(() => sendFromFrame(ch2Frame, { source: "biocn-reader", type: "ready" }));
    act(() => sendFromFrame(ch2Frame, { source: "biocn-reader", type: "painted" }));
    expect(ch2Frame).toHaveAttribute("aria-hidden", "false");
    expect(screen.queryByTitle("One")).not.toBeInTheDocument();

    // Internal relative link back to chapter 1 with anchor.
    act(() =>
      sendFromFrame(ch2Frame, {
        source: "biocn-reader",
        type: "link",
        href: "../Text/ch1.xhtml#s1",
      }),
    );
    const ch1Frame = (await screen.findByTitle("One")) as HTMLIFrameElement;
    const postSpy = vi.spyOn(ch1Frame.contentWindow!, "postMessage");
    act(() => sendFromFrame(ch1Frame, { source: "biocn-reader", type: "ready" }));
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "biocn-host",
        type: "init",
        target: { anchor: "s1" },
      }),
      "*",
    );
    act(() => sendFromFrame(ch1Frame, { source: "biocn-reader", type: "painted" }));

    // External link opens via plugin-opener.
    act(() =>
      sendFromFrame(ch1Frame, {
        source: "biocn-reader",
        type: "external",
        href: "https://example.com",
      }),
    );
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com");
  });

  it("turns chapters with arrow keys and stops at the ends", async () => {
    renderReader();
    await screen.findByTitle("One");

    await userEvent.keyboard("{ArrowRight}");
    await screen.findByTitle("Two");

    colorizeMock.mockClear();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByTitle("Two")).toBeInTheDocument();
    expect(colorizeMock).not.toHaveBeenCalled();
  });

  it("toggles top menu and bottom progress bar when tapping the center of the page", async () => {
    renderReader();
    const frame = (await screen.findByTitle("One")) as HTMLIFrameElement;
    const header = document.querySelector("header")!;
    const footer = document.querySelector("footer")!;

    expect(header).toHaveAttribute("aria-hidden", "false");
    expect(footer).toHaveAttribute("aria-hidden", "false");

    act(() => sendFromFrame(frame, { source: "biocn-reader", type: "tap" }));
    expect(header).toHaveAttribute("aria-hidden", "true");
    expect(footer).toHaveAttribute("aria-hidden", "true");

    act(() => sendFromFrame(frame, { source: "biocn-reader", type: "tap" }));
    expect(header).toHaveAttribute("aria-hidden", "false");
    expect(footer).toHaveAttribute("aria-hidden", "false");
  });

  it("restores saved progress when opening a book", async () => {
    openMock.mockResolvedValue({
      ...sampleBook,
      initialChapter: 2,
      progress: { chapterIndex: 2, paragraphIndex: 7, ratio: 0.45, updatedAt: 100 },
    });
    renderReader();
    const frame = (await screen.findByTitle("Two")) as HTMLIFrameElement;
    const postSpy = vi.spyOn(frame.contentWindow!, "postMessage");
    act(() => sendFromFrame(frame, { source: "biocn-reader", type: "ready" }));
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "biocn-host",
        type: "init",
        target: { paragraphIndex: 7, ratio: 0.45 },
      }),
      "*",
    );
  });

  it("shows footnotes in a hover popover (not a modal dialog), keeps open while hovering the card, and closes on leave", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderReader({ onClose });
    const frame = (await screen.findByTitle("One")) as HTMLIFrameElement;
    const postSpy = vi.spyOn(frame.contentWindow!, "postMessage");
    act(() => sendFromFrame(frame, { source: "biocn-reader", type: "ready" }));
    postSpy.mockClear();

    // Hovering a same-chapter footnote shows a floating popover, not a modal dialog.
    act(() =>
      sendFromFrame(frame, {
        source: "biocn-reader",
        type: "footnote",
        href: "#fn1",
        anchor: "fn1",
        label: "[1]",
        html: '<p>这是一条<span class="svo svo-subject">脚注</span>说明。<script>window.__bad = 1</script><a href="https://example.org/note">来源</a></p>',
        sameChapter: true,
        trigger: "hover",
        rect: { top: 300, bottom: 318, left: 200, right: 220 },
      }),
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const popover = screen.getByRole("region", { name: /注释/ });
    expect(within(popover).getByText("[1]")).toBeInTheDocument();
    expect(within(popover).getByText(/说明。/)).toBeInTheDocument();
    expect(within(popover).getByText("脚注")).toBeInTheDocument();
    expect(popover.querySelector("script")).toBeNull();

    // Moving from link into the hovercard cancels the leave timer so links remain clickable.
    act(() => sendFromFrame(frame, { source: "biocn-reader", type: "footnote-leave" }));
    await user.hover(popover);
    await new Promise((resolve) => setTimeout(resolve, 280));
    expect(screen.getByRole("region", { name: /注释/ })).toBeInTheDocument();

    // External link inside footnote opens via opener without leaving the chapter.
    await user.click(within(popover).getByRole("link", { name: "来源" }));
    expect(openUrlMock).toHaveBeenCalledWith("https://example.org/note");

    // Moving out of the hovercard auto-closes it after the grace delay.
    await user.unhover(popover);
    await waitFor(() => expect(screen.queryByRole("region", { name: /注释/ })).not.toBeInTheDocument());

    // Clicking a footnote pins the popover, supports jumping on demand, and closes cleanly.
    act(() =>
      sendFromFrame(frame, {
        source: "biocn-reader",
        type: "footnote",
        href: "#fn1",
        anchor: "fn1",
        label: "[1]",
        html: "<p>点击固定的注释</p>",
        sameChapter: true,
        trigger: "click",
      }),
    );
    const pinned = screen.getByRole("region", { name: /注释/ });
    await user.click(within(pinned).getByRole("button", { name: "跳转到注释处" }));
    expect(screen.queryByRole("region", { name: /注释/ })).not.toBeInTheDocument();
    expect(postSpy).toHaveBeenCalledWith(
      { source: "biocn-host", type: "jump", anchor: "fn1" },
      "*",
    );
    expect(onClose).not.toHaveBeenCalled();

    // Cross-chapter plain footnote href (`ch2.xhtml#fn2`) probes iframe first.
    postSpy.mockClear();
    act(() =>
      sendFromFrame(frame, {
        source: "biocn-reader",
        type: "link",
        href: "../Text/ch2.xhtml#fn2",
      }),
    );
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "biocn-host",
        type: "resolve-footnote",
        href: "../Text/ch2.xhtml#fn2",
        anchor: "fn2",
      }),
      "*",
    );
    const resolveCall = postSpy.mock.calls.find(
      ([payload]) => (payload as { type?: string }).type === "resolve-footnote",
    );
    const requestId = (resolveCall![0] as { requestId: number }).requestId;

    // When iframe resolves the cross-chapter note, open floating popover instead of switching chapters.
    act(() =>
      sendFromFrame(frame, {
        source: "biocn-reader",
        type: "footnote-result",
        requestId,
        href: "../Text/ch2.xhtml#fn2",
        anchor: "fn2",
        found: true,
        label: "注释",
        html: "<p>跨章尾注正文</p>",
      }),
    );
    const remotePopover = screen.getByRole("region", { name: /注释/ });
    expect(within(remotePopover).getByText("跨章尾注正文")).toBeInTheDocument();
    expect(within(remotePopover).queryByRole("button", { name: "关闭注释" })).not.toBeInTheDocument();
    expect(screen.queryByTitle("Two")).not.toBeInTheDocument();

    // Tapping the page dismisses the floating popover without closing the reader.
    act(() => sendFromFrame(frame, { source: "biocn-reader", type: "tap" }));
    expect(screen.queryByRole("region", { name: /注释/ })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cancels active coloring and skips coloring future chapters when the 着色 button is off", async () => {
    const user = userEvent.setup();
    colorizeMock.mockResolvedValue({
      index: 1,
      totalSentences: 10,
      cachedSentences: 2,
      fullyColored: false,
      missingModel: false,
    });
    renderReader();
    const frame = (await screen.findByTitle("One")) as HTMLIFrameElement;
    act(() => sendFromFrame(frame, { source: "biocn-reader", type: "ready" }));

    // Active coloring indicator is visible while enabled.
    expect(await screen.findByRole("status", { name: "本章着色进度" })).toHaveTextContent(
      "着色 20%",
    );

    const toggleBtn = screen.getByRole("button", { name: "着色" });
    await user.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute("aria-pressed", "false");
    expect(document.activeElement).not.toBe(toggleBtn);
    expect(cancelStreamMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status", { name: "本章着色进度" })).not.toBeInTheDocument();

    // Navigating to chapter 2 while coloring is off must NOT trigger coloring.
    colorizeMock.mockClear();
    await user.click(screen.getByRole("button", { name: "下一章" }));
    const ch2Frame = (await screen.findByTitle("Two")) as HTMLIFrameElement;
    expect(ch2Frame.getAttribute("src")).toContain("biocn=off");
    expect(colorizeMock).not.toHaveBeenCalled();

    // Turning coloring back on starts coloring for chapter 2 immediately.
    await user.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(colorizeMock).toHaveBeenCalledWith("dune", 2));
  });

  it("dismisses TOC drawer and footnote popup via browser back without closing the reader", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderReader({ onClose });
    const frame = (await screen.findByTitle("One")) as HTMLIFrameElement;
    act(() => sendFromFrame(frame, { source: "biocn-reader", type: "ready" }));

    await user.click(screen.getByRole("button", { name: "目录" }));
    expect(screen.getByRole("button", { name: "目录" })).toHaveAttribute("aria-expanded", "true");

    act(() => {
      window.history.back();
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "目录" })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
    expect(onClose).not.toHaveBeenCalled();

    act(() =>
      sendFromFrame(frame, {
        source: "biocn-reader",
        type: "footnote",
        href: "#fn1",
        anchor: "fn1",
        label: "[1]",
        html: "<p>注释正文</p>",
        sameChapter: true,
        trigger: "click",
      }),
    );
    expect(screen.getByRole("region", { name: /注释/ })).toBeInTheDocument();

    act(() => {
      window.history.back();
    });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: /注释/ })).not.toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
