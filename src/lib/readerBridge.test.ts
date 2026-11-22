import { beforeEach, describe, expect, it, vi } from "vitest";
import bridgeSource from "../../src-tauri/src/protocol/bridge.js?raw";
import { DEFAULT_READER_PREFS } from "./readerPrefs";

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
    document.querySelector("p")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, clientX: 500 }),
    );
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
    document.querySelector("p")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, clientX: 200 }),
    );
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
});
