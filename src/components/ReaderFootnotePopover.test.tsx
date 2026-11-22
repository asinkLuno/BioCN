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
  it("places the card above the anchor when enough space exists and clamps horizontally", () => {
    // Anchor near the left edge in the lower half of a 1000x800 viewport.
    const layout = computeFootnotePopoverLayout(
      { top: 500, bottom: 518, left: 20, right: 36 },
      { width: 1000, height: 800 },
    );
    expect(layout.placement).toBe("top");
    expect(layout.left).toBe(12);
    expect(layout.bottom).toBe(800 - 500 + 8);
    expect(layout.width).toBe(384);
    expect(layout.maxHeight).toBeGreaterThanOrEqual(120);
  });

  it("flips below the anchor when near the top edge and clamps near the right edge", () => {
    const layout = computeFootnotePopoverLayout(
      { top: 60, bottom: 78, left: 960, right: 980 },
      { width: 1000, height: 800 },
    );
    expect(layout.placement).toBe("bottom");
    expect(layout.top).toBe(78 + 8);
    expect(layout.left).toBe(1000 - 12 - layout.width);
  });

  it("falls back to bottom-centered placement when anchor coordinates are absent", () => {
    const layout = computeFootnotePopoverLayout(null, { width: 1000, height: 800 });
    expect(layout.placement).toBe("top");
    expect(layout.left).toBe(Math.round((1000 - 384) / 2));
    expect(layout.bottom).toBe(24);
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

  it("renders as a non-modal floating card and notifies pointer enter/leave for hover-bridging", async () => {
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

    await user.hover(region);
    expect(onPointerEnter).toHaveBeenCalledTimes(1);

    await user.unhover(region);
    expect(onPointerLeave).toHaveBeenCalledTimes(1);
  });
});
