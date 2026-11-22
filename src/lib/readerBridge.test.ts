import { beforeEach, describe, expect, it, vi } from "vitest";
import bridgeSource from "../../src-tauri/src/protocol/bridge.js?raw";
import { isFrameMessage } from "./readerBridge";
import { DEFAULT_READER_PREFS } from "./readerPrefs";

describe("isFrameMessage boundary validation", () => {
  it("accepts valid messages and rejects malformed payloads or unsafe external schemes", () => {
    expect(isFrameMessage({ source: "biocn-reader", type: "ready" })).toBe(true);
    expect(
      isFrameMessage({ source: "biocn-reader", type: "external", href: "https://example.com" }),
    ).toBe(true);
    expect(
      isFrameMessage({ source: "biocn-reader", type: "external", href: "javascript:alert(1)" }),
    ).toBe(false);
    expect(
      isFrameMessage({ source: "biocn-reader", type: "external", href: "file:///etc/passwd" }),
    ).toBe(false);
    expect(isFrameMessage({ source: "biocn-reader", type: "progress", ratio: Number.NaN })).toBe(
      false,
    );
    expect(isFrameMessage({ source: "biocn-reader", type: "turn", direction: "sideways" })).toBe(
      false,
    );
    expect(
      isFrameMessage({
        source: "biocn-reader",
        type: "footnote",
        href: "#fn1",
        anchor: "fn1",
        label: "[1]",
        html: "<p>注释</p>",
        sameChapter: true,
      }),
    ).toBe(true);
    expect(
      isFrameMessage({
        source: "biocn-reader",
        type: "footnote",
        href: "#fn1",
        anchor: "fn1",
        label: "[1]",
        html: "",
        sameChapter: true,
      }),
    ).toBe(false);
    expect(
      isFrameMessage({
        source: "biocn-reader",
        type: "footnote",
        href: "#fn1",
        anchor: "fn1",
        label: "[1]",
        html: "<p>注释</p>",
        sameChapter: true,
        trigger: "hover",
        rect: { top: 100, bottom: 118, left: 200, right: 220 },
      }),
    ).toBe(true);
    expect(
      isFrameMessage({
        source: "biocn-reader",
        type: "footnote",
        href: "#fn1",
        anchor: "fn1",
        label: "[1]",
        html: "<p>注释</p>",
        sameChapter: true,
        trigger: "focus",
      }),
    ).toBe(false);
    expect(
      isFrameMessage({
        source: "biocn-reader",
        type: "footnote",
        href: "#fn1",
        anchor: "fn1",
        label: "[1]",
        html: "<p>注释</p>",
        sameChapter: true,
        rect: { top: Number.NaN, bottom: 118, left: 200, right: 220 },
      }),
    ).toBe(false);
    expect(isFrameMessage({ source: "biocn-reader", type: "footnote-leave" })).toBe(true);
    expect(
      isFrameMessage({
        source: "biocn-reader",
        type: "footnote-result",
        requestId: 1,
        href: "notes.xhtml#fn1",
        anchor: "fn1",
        found: true,
        label: "注释",
        html: "<p>尾注内容</p>",
      }),
    ).toBe(true);
  });
});

describe("reader iframe bridge.js", () => {
  let posted: unknown[];

  beforeEach(() => {
    posted = [];
    delete (window as unknown as { __biocnBridge?: boolean }).__biocnBridge;
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-mode");
    document.documentElement.removeAttribute("data-biocn");
    document.documentElement.removeAttribute("data-font");
    document.documentElement.removeAttribute("data-margin");
    document.documentElement.removeAttribute("data-align");
    document.documentElement.removeAttribute("data-dim-images");
    document.documentElement.style.removeProperty("--svo-subject");
    document.documentElement.style.removeProperty("--svo-predicate");
    document.documentElement.style.removeProperty("--svo-object");
    document.documentElement.style.removeProperty("--reader-para-spacing");
    document.body.innerHTML = `
      <p><span data-bp="0"></span><span data-br="0-0">他</span><em><span data-br="0-1">走</span></em><span data-br="0-2">了。</span></p>
      <p><a id="rel" href="../Text/ch2.xhtml#fn1">注释</a> <a id="ext" href="https://example.com">外链</a></p>
    `;
    vi.spyOn(window.parent, "postMessage").mockImplementation((msg: unknown) => {
      posted.push(msg);
    });
    // Execute bridge script as injected into the chapter document.
    new Function(bridgeSource)();
  });

  it("signals ready, applies prefs, patches progressive coloring runs, and intercepts links", () => {
    expect(posted).toContainEqual({ source: "biocn-reader", type: "ready" });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "biocn-host",
          type: "init",
          prefs: {
            ...DEFAULT_READER_PREFS,
            theme: "sepia",
            fontFamily: "serif",
            fontSize: 20,
            paragraphSpacing: 1.2,
            pageMargin: "wide",
            textAlign: "justify",
            dimImagesInDark: false,
            svoColors: { subject: "#b03a2e", predicate: null, object: "#4a4e91" },
          },
          target: {},
        },
      }),
    );

    expect(document.documentElement.getAttribute("data-theme")).toBe("sepia");
    expect(document.documentElement.getAttribute("data-biocn")).toBe("on");
    expect(document.documentElement.getAttribute("data-font")).toBe("serif");
    expect(document.documentElement.getAttribute("data-margin")).toBe("wide");
    expect(document.documentElement.getAttribute("data-align")).toBe("justify");
    expect(document.documentElement.getAttribute("data-dim-images")).toBe("off");
    expect(document.documentElement.style.getPropertyValue("--svo-subject")).toBe("#b03a2e");
    expect(document.documentElement.style.getPropertyValue("--svo-predicate")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--svo-object")).toBe("#4a4e91");
    expect(document.documentElement.style.getPropertyValue("--reader-font-size")).toBe("20px");
    expect(document.documentElement.style.getPropertyValue("--reader-para-spacing")).toBe("1.2em");

    // Progressive coloring patch swaps data-br runs cleanly in place.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "biocn-host",
          type: "patch",
          patches: [
            { key: "0-0", html: '<span class="svo svo-subject">他</span>' },
            { key: "0-1", html: '<span class="svo svo-predicate">走</span>' },
            { key: "0-2", html: "了。" },
          ],
        },
      }),
    );

    expect(document.querySelector('[data-br="0-0"]')).toBeNull();
    expect(document.querySelector(".svo-subject")?.textContent).toBe("他");

    // Resetting custom SVO colors removes any initial `#biocn-svo-override` style tag.
    const override = document.createElement("style");
    override.id = "biocn-svo-override";
    override.textContent = "html[data-theme] { --svo-subject: #b03a2e; }";
    document.head.appendChild(override);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "biocn-host",
          type: "prefs",
          prefs: {
            ...DEFAULT_READER_PREFS,
            svoColors: { subject: null, predicate: null, object: null },
          },
        },
      }),
    );
    expect(document.getElementById("biocn-svo-override")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--svo-subject")).toBe("");
    expect(document.querySelector(".svo-predicate")?.textContent).toBe("走");
    expect(document.querySelector("p")?.textContent).toBe("他走了。");

    // Toggle coloring off live.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "biocn-host",
          type: "prefs",
          prefs: { ...DEFAULT_READER_PREFS, coloringEnabled: false },
        },
      }),
    );
    expect(document.documentElement.getAttribute("data-biocn")).toBe("off");

    // Internal relative link & external link interception.
    document.getElementById("rel")!.click();
    expect(posted).toContainEqual({
      source: "biocn-reader",
      type: "link",
      href: "../Text/ch2.xhtml#fn1",
    });

    document.getElementById("ext")!.click();
    expect(posted).toContainEqual({
      source: "biocn-reader",
      type: "external",
      href: "https://example.com",
    });

    // Clicking the center of prose emits `tap` to toggle reader chrome.
    posted = [];
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    document
      .querySelector("p")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, clientX: 500 }));
    expect(posted).toContainEqual({ source: "biocn-reader", type: "tap" });
  });

  it("supports 1:1 touch drag-follow and swipe page turning in paginated mode", () => {
    Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
    // Two pages wide (stride is 400 in single-column mobile layout).
    Object.defineProperty(document.body, "scrollWidth", {
      value: 800,
      configurable: true,
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "biocn-host",
          type: "init",
          prefs: { ...DEFAULT_READER_PREFS, viewMode: "paginated", columns: 1 },
          target: {},
        },
      }),
    );

    const makeTouchEvent = (type: string, clientX: number, clientY = 200) => {
      const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & {
        touches: { clientX: number; clientY: number }[];
        changedTouches: { clientX: number; clientY: number }[];
      };
      const point = { clientX, clientY };
      ev.touches = type === "touchend" || type === "touchcancel" ? [] : [point];
      ev.changedTouches = [point];
      return ev;
    };

    posted = [];
    window.dispatchEvent(makeTouchEvent("touchstart", 300));
    window.dispatchEvent(makeTouchEvent("touchmove", 180));
    // Live 1:1 drag follow: dragged 120px left -> scrollLeft moved to 120.
    expect(document.body.scrollLeft).toBe(120);

    window.dispatchEvent(makeTouchEvent("touchend", 150));
    // Committed turn to page 1 (second page).
    expect(posted).toContainEqual(
      expect.objectContaining({
        source: "biocn-reader",
        type: "progress",
        mode: "paginated",
        page: 1,
        totalPages: 2,
      }),
    );

    // Stray click immediately after swipe is suppressed (no bogus `tap`).
    posted = [];
    document
      .querySelector("p")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, clientX: 200 }));
    expect(posted).not.toContainEqual({ source: "biocn-reader", type: "tap" });

    // Swiping left again on the last page asks host to turn to the next chapter.
    posted = [];
    window.dispatchEvent(makeTouchEvent("touchstart", 300));
    window.dispatchEvent(makeTouchEvent("touchmove", 120));
    window.dispatchEvent(makeTouchEvent("touchend", 100));
    expect(posted).toContainEqual({
      source: "biocn-reader",
      type: "turn",
      direction: "next",
    });
  });

  it("supports horizontal swipe to switch chapters in scrolled mode", () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "biocn-host",
          type: "init",
          prefs: { ...DEFAULT_READER_PREFS, viewMode: "scrolled" },
          target: {},
        },
      }),
    );

    const makeTouchEvent = (type: string, clientX: number, clientY = 200) => {
      const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & {
        touches: { clientX: number; clientY: number }[];
        changedTouches: { clientX: number; clientY: number }[];
      };
      const point = { clientX, clientY };
      ev.touches = type === "touchend" ? [] : [point];
      ev.changedTouches = [point];
      return ev;
    };

    posted = [];
    window.dispatchEvent(makeTouchEvent("touchstart", 320));
    window.dispatchEvent(makeTouchEvent("touchmove", 200));
    window.dispatchEvent(makeTouchEvent("touchend", 180));
    expect(posted).toContainEqual({
      source: "biocn-reader",
      type: "turn",
      direction: "next",
    });
  });

  it("extracts same-chapter EPUB 3 and EPUB 2 footnotes as popup messages without jumping", () => {
    document.body.innerHTML = `
      <p>正文句子<a id="ref1" epub:type="noteref" href="#fn1">1</a>和另一个脚注<sup><a id="ref2" href="#fn2">[2]</a></sup>。</p>
      <p><a id="sec-link" href="#sec-title">跳到标题</a></p>
      <h2 id="sec-title">第一节</h2>
      <aside id="fn1" epub:type="footnote"><p>第一条注释内容。<a epub:type="backlink" href="#ref1">↩</a></p></aside>
      <div class="footnotes">
        <p><a id="fn2" href="#ref2">[2]</a> 第二条注释内容。</p>
      </div>
    `;

    // EPUB 3 noteref -> aside footnote (backlink stripped)
    posted = [];
    document.getElementById("ref1")!.click();
    expect(posted).toContainEqual(
      expect.objectContaining({
        source: "biocn-reader",
        type: "footnote",
        href: "#fn1",
        anchor: "fn1",
        label: "1",
        sameChapter: true,
      }),
    );
    const fn1Msg = posted.find((m) => (m as { type?: string }).type === "footnote") as {
      html: string;
    };
    expect(fn1Msg.html).toContain("第一条注释内容。");
    expect(fn1Msg.html).not.toContain("↩");

    // EPUB 2 sup link -> inline anchor inside <p> (backlink stripped)
    posted = [];
    document.getElementById("ref2")!.click();
    expect(posted).toContainEqual(
      expect.objectContaining({
        source: "biocn-reader",
        type: "footnote",
        href: "#fn2",
        anchor: "fn2",
        label: "[2]",
        sameChapter: true,
      }),
    );
    const fn2Msg = posted.find((m) => (m as { type?: string }).type === "footnote") as {
      html: string;
    };
    expect(fn2Msg.html).toContain("第二条注释内容。");
    expect(fn2Msg.html).not.toContain("#ref2");

    // Clicking a backlink inside a footnote must NOT pop up the body paragraph
    posted = [];
    document.querySelector<HTMLAnchorElement>('a[href="#ref1"]')!.click();
    expect(posted.some((m) => (m as { type?: string }).type === "footnote")).toBe(false);

    // Clicking a link to a section heading must NOT pop up a footnote
    posted = [];
    document.getElementById("sec-link")!.click();
    expect(posted.some((m) => (m as { type?: string }).type === "footnote")).toBe(false);
  });

  it("extracts footnotes on hover with anchor coordinates and emits footnote-leave on mouseout", async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = `
        <p>正文句子<a id="ref1" epub:type="noteref" href="#fn1">1</a>和<a id="sec-link" href="#sec-title">标题</a>。</p>
        <h2 id="sec-title">第一节</h2>
        <aside id="fn1" epub:type="footnote"><p>悬停显示的注释内容。<a epub:type="backlink" href="#ref1">↩</a></p></aside>
      `;

      const ref1 = document.getElementById("ref1")!;
      ref1.getBoundingClientRect = () =>
        ({
          top: 120,
          bottom: 138,
          left: 240,
          right: 256,
          width: 16,
          height: 18,
          x: 240,
          y: 120,
          toJSON: () => ({}),
        }) as DOMRect;

      // Brief sweep across the link cancels before posting (no flicker).
      posted = [];
      ref1.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(50);
      ref1.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
      vi.advanceTimersByTime(200);
      expect(posted.some((m) => (m as { type?: string }).type === "footnote")).toBe(false);

      // Pausing over the footnote link emits a hover footnote with its bounding rect.
      posted = [];
      ref1.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(150);
      expect(posted).toContainEqual(
        expect.objectContaining({
          source: "biocn-reader",
          type: "footnote",
          href: "#fn1",
          anchor: "fn1",
          label: "1",
          sameChapter: true,
          trigger: "hover",
          rect: { top: 120, bottom: 138, left: 240, right: 256 },
        }),
      );

      // Moving the cursor off the footnote link emits footnote-leave so host can start grace close.
      posted = [];
      ref1.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
      expect(posted).toContainEqual({
        source: "biocn-reader",
        type: "footnote-leave",
      });

      // Hovering a regular section link never posts a footnote or navigates.
      posted = [];
      const secLink = document.getElementById("sec-link")!;
      secLink.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(200);
      expect(posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fetches cross-chapter footnotes same-origin and falls back to link navigation on miss", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        `<html><body><ol><li id="n1"><p>跨章尾注说明。<a href="#ref-n1">返回</a></p></li></ol></body></html>`,
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      document.body.innerHTML = `
        <p>正文<sup><a id="ref-n1" href="notes.xhtml#n1">①</a></sup>与缺失脚注<sup><a id="ref-miss" href="notes.xhtml#missing">②</a></sup></p>
      `;

      posted = [];
      document.getElementById("ref-n1")!.click();
      await vi.waitFor(() => {
        expect(posted).toContainEqual(
          expect.objectContaining({
            source: "biocn-reader",
            type: "footnote",
            href: "notes.xhtml#n1",
            anchor: "n1",
            label: "①",
            sameChapter: false,
          }),
        );
      });
      const remoteMsg = posted.find((m) => (m as { type?: string }).type === "footnote") as {
        html: string;
      };
      expect(remoteMsg.html).toContain("跨章尾注说明。");
      expect(remoteMsg.html).not.toContain("返回");
      const callsAfterFirst = fetchMock.mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

      // Second lookup against the same document reuses the parsed cache and falls back cleanly on missing anchor.
      posted = [];
      document.getElementById("ref-miss")!.click();
      await vi.waitFor(() => {
        expect(posted).toContainEqual({
          source: "biocn-reader",
          type: "link",
          href: "notes.xhtml#missing",
        });
      });
      expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirst);

      // Host `resolve-footnote` command resolves remote note & reports found/not-found.
      posted = [];
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            source: "biocn-host",
            type: "resolve-footnote",
            requestId: 7,
            href: "notes.xhtml#n1",
            anchor: "n1",
          },
        }),
      );
      await vi.waitFor(() => {
        expect(posted).toContainEqual(
          expect.objectContaining({
            source: "biocn-reader",
            type: "footnote-result",
            requestId: 7,
            found: true,
          }),
        );
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("appends invisible trailing columns on multi-page chapters and cleans up in scrolled mode", () => {
    // 2-column desktop spread (1100px wide, 3 columns -> scrollWidth 1622 < 2 * 1100)
    Object.defineProperty(window, "innerWidth", { value: 1100, configurable: true });
    Object.defineProperty(document.body, "scrollWidth", {
      value: 1622,
      configurable: true,
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "biocn-host",
          type: "init",
          prefs: { ...DEFAULT_READER_PREFS, viewMode: "paginated", columns: 2 },
          target: {},
        },
      }),
    );

    const tail = document.getElementById("biocn-page-tail");
    expect(tail).not.toBeNull();
    expect(tail!.style.display).toBe("block");
    expect(tail!.querySelectorAll(".biocn-page-tail-col")).toHaveLength(2);

    // Switching to 1-column mode adjusts the spacer to 1 trailing column.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "biocn-host",
          type: "prefs",
          prefs: { ...DEFAULT_READER_PREFS, viewMode: "paginated", columns: 1 },
        },
      }),
    );
    expect(document.querySelectorAll("#biocn-page-tail .biocn-page-tail-col")).toHaveLength(1);

    // Switching back to scrolled mode removes the spacer completely.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "biocn-host",
          type: "prefs",
          prefs: { ...DEFAULT_READER_PREFS, viewMode: "scrolled" },
        },
      }),
    );
    expect(document.getElementById("biocn-page-tail")).toBeNull();
  });
});
