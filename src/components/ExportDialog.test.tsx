import { cleanup, render, screen } from "@testing-library/react";
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

  it("toggles an information panel explaining inline and external EPUB CSS styles", async () => {
    const user = userEvent.setup();
    render(<ExportDialog id="dune" title="Dune" onClose={vi.fn()} />);

    const group = screen.getByRole("group", { name: "CSS 样式" });
    expect(group).toBeInTheDocument();

    const infoButton = screen.getByRole("button", { name: "了解内联与外联样式的区别" });
    expect(infoButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    await user.click(infoButton);

    expect(infoButton).toHaveAttribute("aria-expanded", "true");
    const note = screen.getByRole("note");
    expect(note).toHaveAttribute("id", infoButton.getAttribute("aria-controls"));
    expect(note).toHaveTextContent(/单个\s*\.epub/);
    expect(note).toHaveTextContent(/内联/);
    expect(note).toHaveTextContent(/<style>/);
    expect(note).toHaveTextContent(/外联/);
    expect(note).toHaveTextContent(/biocn\.css/);
    expect(note).toHaveTextContent(/<link>/);
    // Informational help must not use role="alert", which is reserved for export errors.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(infoButton);

    expect(infoButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("still exports with the chosen stylesheet while the information panel is open", async () => {
    const user = userEvent.setup();
    mocks.save.mockResolvedValue("/books/Dune.epub");
    mocks.exportBook.mockResolvedValue({ colored: 4, chapters: 4, skipped: 0 });
    render(<ExportDialog id="dune" title="Dune" onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "了解内联与外联样式的区别" }));
    expect(screen.getByRole("note")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /外联/ }));
    await user.click(screen.getByRole("button", { name: "选择位置并导出" }));

    expect(mocks.exportBook).toHaveBeenCalledWith("dune", "/books/Dune.epub", "external");
    expect(await screen.findByRole("status")).toHaveTextContent("已导出到 Dune.epub");
  });
});
