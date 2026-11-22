import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportDialog } from "./ExportDialog";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  exportBook: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: mocks.save,
}));

vi.mock("../lib/exporting", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exporting")>();
  return {
    ...actual,
    exportBook: mocks.exportBook,
  };
});

describe("ExportDialog", () => {
  beforeEach(() => {
    mocks.save.mockReset();
    mocks.exportBook.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("provides individual hover information tooltips for inline and external CSS styles", async () => {
    const user = userEvent.setup();
    render(<ExportDialog id="dune" title="Dune" onClose={vi.fn()} />);

    const group = screen.getByRole("group", { name: "CSS 样式" });
    const inlineInfo = within(group).getByRole("button", { name: "内联样式说明" });
    const externalInfo = within(group).getByRole("button", { name: "外联样式说明" });

    // Each trigger lives inside a daisyUI hover tooltip paired with its own description.
    const inlineWrapper = inlineInfo.closest(".tooltip");
    const externalWrapper = externalInfo.closest(".tooltip");
    expect(inlineWrapper).not.toBeNull();
    expect(externalWrapper).not.toBeNull();

    const inlineTip = within(inlineWrapper as HTMLElement).getByRole("tooltip");
    const externalTip = within(externalWrapper as HTMLElement).getByRole("tooltip");

    expect(inlineTip).toHaveAttribute("id", inlineInfo.getAttribute("aria-describedby"));
    expect(inlineTip).toHaveTextContent(/单个\s*\.epub/);
    expect(inlineTip).toHaveTextContent(/<style>/);

    expect(externalTip).toHaveAttribute("id", externalInfo.getAttribute("aria-describedby"));
    expect(externalTip).toHaveTextContent(/单个\s*\.epub/);
    expect(externalTip).toHaveTextContent(/biocn\.css/);
    expect(externalTip).toHaveTextContent(/<link>/);

    // Hovering an info icon must not change the selected stylesheet radio.
    await user.hover(externalInfo);
    expect(within(group).getByRole("radio", { name: /内联/ })).toBeChecked();
    expect(within(group).getByRole("radio", { name: /外联/ })).not.toBeChecked();
    // Informational tooltips must not use role="alert", which is reserved for export errors.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("selects external style via its radio label and exports cleanly", async () => {
    const user = userEvent.setup();
    mocks.save.mockResolvedValue("/books/Dune.epub");
    mocks.exportBook.mockResolvedValue({ colored: 4, chapters: 4, skipped: 0 });
    render(<ExportDialog id="dune" title="Dune" onClose={vi.fn()} />);

    await user.click(screen.getByRole("radio", { name: /外联/ }));
    await user.click(screen.getByRole("button", { name: "选择位置并导出" }));

    expect(mocks.exportBook).toHaveBeenCalledWith("dune", "/books/Dune.epub", "external");
    expect(await screen.findByRole("status")).toHaveTextContent("已导出到 Dune.epub");
  });
});
