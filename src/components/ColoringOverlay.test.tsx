import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ColoringProgress } from "../lib/reading";
import { ColoringOverlay } from "./ColoringOverlay";

function makeProgress(overrides: Partial<ColoringProgress> = {}): ColoringProgress {
  return {
    book: "dune",
    done: 0,
    total: 0,
    chapters: 0,
    chaptersTotal: 0,
    finished: false,
    cancelled: false,
    error: null,
    ...overrides,
  };
}

describe("ColoringOverlay", () => {
  it("renders looping brand helix and 准备中… before sentences are counted", () => {
    render(<ColoringOverlay progress={makeProgress()} />);

    const status = screen.getByRole("status", { name: "着色进度" });
    expect(status).toHaveTextContent("准备中…");
    expect(status).not.toHaveTextContent("章");
    expect(status.querySelector("svg[data-helix-loader]")).not.toBeNull();
    expect(status.querySelector(".biocn-helix-strand")).not.toBeNull();
  });

  it("displays tabular percentage and chapter counts beneath the helix", () => {
    render(
      <ColoringOverlay
        progress={makeProgress({ done: 50, total: 200, chapters: 1, chaptersTotal: 4 })}
      />,
    );

    const status = screen.getByRole("status", { name: "着色进度" });
    expect(status).toHaveTextContent("25%");
    expect(status).toHaveTextContent("1/4 章");
    expect(status.querySelector("svg[data-helix-loader]")).not.toBeNull();
    expect(status.querySelector("progress")).toHaveAttribute("value", "50");
    expect(status.querySelector("progress")).toHaveAttribute("max", "200");
  });

  it("clamps overflowed sentence and chapter counts safely", () => {
    render(
      <ColoringOverlay
        progress={makeProgress({ done: 250, total: 200, chapters: 6, chaptersTotal: 4 })}
      />,
    );

    const status = screen.getByRole("status", { name: "着色进度" });
    expect(status).toHaveTextContent("100%");
    expect(status).toHaveTextContent("4/4 章");
  });
});
