import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_READER_PREFS } from "../lib/readerPrefs";
import {
  computeFootnotePopoverLayout,
  type FootnoteView,
  ReaderFootnotePopover,
} from "./ReaderFootnotePopover";

describe("computeFootnotePopoverLayout", () => {
  it("places the pop-up above the anchor, clamps horizontally, and points the arrow at the anchor center", () => {
    // Anchor near the left edge (center = 28) in the lower half of a 1000x800 viewport.
    const layout = computeFootnotePopoverLayout(
      { top: 500, bottom: 518, left: 20, right: 36 },
      { width: 1000, height: 800 },
    );
    expect(layout.placement).toBe("top");
    expect(layout.left).toBe(12);
    expect(layout.bottom).toBe(800 - 500 + 10);
    expect(layout.maxWidth).toBe(340);
    // Arrow points at anchor center (28 - 12 = 16), clamped inside rounded corners.
    expect(layout.arrowLeft).toBe(16);
    expect(layout.maxHeight).toBeGreaterThanOrEqual(120);
  });

  it("centers compact pop-ups tightly over the anchor when measured width is smaller than maxWidth", () => {
    const layout = computeFootnotePopoverLayout(
      { top: 400, bottom: 418, left: 490, right: 510 },
      { width: 1000, height: 800 },
      200,
    );
    // Anchor center is 500 -> 200px bubble sits at left=400, arrow dead center at 100.
    expect(layout.left).toBe(400);
    expect(layout.arrowLeft).toBe(100);
  });

  it("flips below the anchor when near the top edge and clamps near the right edge", () => {
    const layout = computeFootnotePopoverLayout(
      { top: 60, bottom: 78, left: 960, right: 980 },
      { width: 1000, height: 800 },
    );
    expect(layout.placement).toBe("bottom");
    expect(layout.top).toBe(78 + 10);
    expect(layout.left).toBe(1000 - 12 - layout.maxWidth);
    // Anchor center is 970 -> 970 - (1000 - 12 - 340) = 322 (within corner inset).
    expect(layout.arrowLeft).toBe(322);

    // Extreme right edge clamps the arrow inside the rounded corner inset (maxWidth - 16).
    const extremeRight = computeFootnotePopoverLayout(
      { top: 60, bottom: 78, left: 984, right: 998 },
      { width: 1000, height: 800 },
    );
    expect(extremeRight.arrowLeft).toBe(extremeRight.maxWidth - 16);
  });

  it("falls back to bottom-centered placement with no pointer arrow when anchor is absent", () => {
    const layout = computeFootnotePopoverLayout(null, { width: 1000, height: 800 });
    expect(layout.placement).toBe("top");
    expect(layout.left).toBe(Math.round((1000 - 340) / 2));
    expect(layout.bottom).toBe(24);
    expect(layout.arrowLeft).toBeNull();
  });
});

describe("ReaderFootnotePopover", () => {
  afterEach(() => {
    cleanup();
  });

  const sample: FootnoteView = {
    label: "[1]",
    nodes: [{ kind: "element", tag: "p", children: [{ kind: "text", text: "注释正文内容" }] }],
    targetChapterIndex: 1,
    targetAnchor: "fn1",
    sameChapter: true,
    rect: { top: 400, bottom: 418, left: 300, right: 320 },
    pinned: false,
  };

  it("renders as an anchored pop-up bubble with a pointer arrow and notifies hover enter/leave", async () => {
    const user = userEvent.setup();
    const onPointerEnter = vi.fn();
    const onPointerLeave = vi.fn();
    const onClose = vi.fn();
    render(
      <ReaderFootnotePopover
        footnote={sample}
        prefs={DEFAULT_READER_PREFS}
        effectiveTheme="light"
        onClose={onClose}
        onJumpToTarget={vi.fn()}
        onNavigateInternal={vi.fn()}
        onOpenExternal={vi.fn()}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const region = screen.getByRole("region", { name: /注释/ });
    expect(region).toHaveTextContent("注释正文内容");
    expect(region).toHaveAttribute("data-placement", "top");
    expect(region.querySelector("[data-popover-arrow]")).not.toBeNull();
    // No modal-style heading bar or close button.
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "关闭注释" })).not.toBeInTheDocument();

    await user.hover(region);
    expect(onPointerEnter).toHaveBeenCalledTimes(1);

    await user.unhover(region);
    expect(onPointerLeave).toHaveBeenCalledTimes(1);
  });
});
