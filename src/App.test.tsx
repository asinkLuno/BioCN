import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as library from "./lib/library";
import { open } from "@tauri-apps/plugin-dialog";

vi.mock("./lib/library", () => ({
  libraryList: vi.fn(),
  libraryImport: vi.fn(),
  libraryRemove: vi.fn(),
  libraryCover: vi.fn(),
}));

const openMock = vi.mocked(open);
const listMock = vi.mocked(library.libraryList);
const importMock = vi.mocked(library.libraryImport);
const removeMock = vi.mocked(library.libraryRemove);
const coverMock = vi.mocked(library.libraryCover);

const dune: library.Book = {
  id: "dune",
  title: "Dune",
  authors: ["Frank Herbert"],
  addedAt: 2,
  size: 1024,
  hasCover: false,
};

const emma: library.Book = {
  id: "emma",
  title: "Emma",
  authors: ["Jane Austen"],
  addedAt: 1,
  size: 2048,
  hasCover: false,
};

describe("library", () => {
  beforeEach(() => {
    listMock.mockResolvedValue([]);
    coverMock.mockResolvedValue(null);
    openMock.mockResolvedValue(null);
  });

  it("shows the empty shelf, then the imported book", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("Your shelf is empty")).toBeInTheDocument();
    expect(screen.getByText("No books yet")).toBeInTheDocument();

    openMock.mockResolvedValue("/books/dune.epub");
    importMock.mockResolvedValue({ library: [dune], added: [dune], errors: [] });

    await user.click(screen.getByRole("button", { name: "Choose EPUB files" }));

    const tile = (await screen.findByRole("heading", { name: "Dune" })).closest("li")!;
    expect(within(tile).getByText("Frank Herbert")).toBeInTheDocument();
    expect(screen.getByText("1 book")).toBeInTheDocument();
    expect(screen.queryByText("Your shelf is empty")).not.toBeInTheDocument();
    expect(importMock).toHaveBeenCalledWith(["/books/dune.epub"]);
  });

  it("does nothing when the picker is cancelled", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Your shelf is empty");

    await user.click(screen.getByRole("button", { name: "Add books" }));

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(importMock).not.toHaveBeenCalled();
    expect(screen.getByText("Your shelf is empty")).toBeInTheDocument();
  });

  it("reports files that could not be imported", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Your shelf is empty");

    openMock.mockResolvedValue(["/books/bad.pdf"]);
    importMock.mockResolvedValue({
      library: [],
      added: [],
      errors: [{ name: "bad.pdf", message: "not an EPUB file: invalid archive" }],
    });

    await user.click(screen.getByRole("button", { name: "Add books" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Couldn’t add bad.pdf")).toBeInTheDocument();
    expect(within(alert).getByText(/bad.pdf: not an EPUB file: invalid archive/)).toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("removes a book from the shelf", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune, emma]);
    removeMock.mockResolvedValue([emma]);
    render(<App />);

    expect(await screen.findByText("2 books")).toBeInTheDocument();

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "Actions for Dune" }));
    await user.click(within(tile).getByRole("menuitem", { name: "Remove from library" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(removeMock).toHaveBeenCalledWith("dune");
    await waitFor(() => expect(screen.queryByText("Dune")).not.toBeInTheDocument());
    expect(screen.getByText("1 book")).toBeInTheDocument();
  });

  it("clears the pending tile and reports an unexpected import failure", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Your shelf is empty");

    openMock.mockResolvedValue(["/books/dune.epub", "/books/emma.epub"]);
    importMock.mockRejectedValue("Cannot reach the library on disk");

    await user.click(screen.getByRole("button", { name: "Add books" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Something went wrong")).toBeInTheDocument();
    expect(within(alert).getByText("Cannot reach the library on disk")).toBeInTheDocument();
    expect(document.querySelectorAll(".skeleton")).toHaveLength(0);
  });

  it("shows a placeholder when a cover image fails to decode", async () => {
    listMock.mockResolvedValue([{ ...dune, hasCover: true }]);
    coverMock.mockResolvedValue({ mime: "image/png", base64: "bm90IGFuIGltYWdl" });
    render(<App />);

    const image = await screen.findByRole("presentation", { hidden: true });
    expect(image).toHaveAttribute("src", "data:image/png;base64,bm90IGFuIGltYWdl");

    fireEvent.error(image);

    await waitFor(() =>
      expect(screen.queryByRole("presentation", { hidden: true })).not.toBeInTheDocument(),
    );
  });

  it("does not resurrect a book when an older import finishes later", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    render(<App />);
    await screen.findByText("1 book");

    // The import is still running when the book is removed.
    let finishImport: (report: library.ImportReport) => void = () => {};
    openMock.mockResolvedValue("/books/emma.epub");
    importMock.mockReturnValue(
      new Promise<library.ImportReport>((resolve) => {
        finishImport = resolve;
      }),
    );
    const add = screen.getByRole("button", { name: "Add books" });
    await user.click(add);
    await waitFor(() => expect(importMock).toHaveBeenCalled());

    removeMock.mockResolvedValue([]);
    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "Actions for Dune" }));
    await user.click(within(tile).getByRole("menuitem", { name: "Remove from library" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    // The tile disappears immediately, before any command has resolved.
    await waitFor(() => expect(screen.getByText("No books yet")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Dune" })).not.toBeInTheDocument();

    // A stale snapshot from the import must not overwrite the newer removal.
    finishImport({ library: [dune], added: [dune], errors: [] });
    await waitFor(() => expect(document.querySelectorAll(".skeleton")).toHaveLength(0));
    expect(screen.getByText("No books yet")).toBeInTheDocument();
  });

  it("shows a book again when the user re-adds it after removing it", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    render(<App />);
    await screen.findByText("1 book");

    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "Actions for Dune" }));
    await user.click(within(tile).getByRole("menuitem", { name: "Remove from library" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText("No books yet")).toBeInTheDocument());

    // Importing the same file again must show it, despite the earlier removal.
    openMock.mockResolvedValue("/books/dune.epub");
    importMock.mockResolvedValue({ library: [dune], added: [dune], errors: [] });
    await user.click(screen.getByRole("button", { name: "Add books" }));

    expect(await screen.findByRole("heading", { name: "Dune" })).toBeInTheDocument();
  });

  it("runs a removal after the import that was already in flight", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    render(<App />);
    await screen.findByText("1 book");

    // The import is still copying when the user removes the book.
    let finishImport: (report: library.ImportReport) => void = () => {};
    openMock.mockResolvedValue("/books/dune.epub");
    importMock.mockReturnValue(
      new Promise<library.ImportReport>((resolve) => {
        finishImport = resolve;
      }),
    );
    await user.click(screen.getByRole("button", { name: "Add books" }));
    await waitFor(() => expect(importMock).toHaveBeenCalled());

    removeMock.mockResolvedValue([]);
    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "Actions for Dune" }));
    await user.click(within(tile).getByRole("menuitem", { name: "Remove from library" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText("No books yet")).toBeInTheDocument());

    // The removal waits for the import, so it is the last word on the shelf.
    expect(removeMock).not.toHaveBeenCalled();
    finishImport({ library: [dune], added: [dune], errors: [] });
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("dune"));
    await waitFor(() => expect(document.querySelectorAll(".skeleton")).toHaveLength(0));
    expect(screen.queryByRole("heading", { name: "Dune" })).not.toBeInTheDocument();
  });

  it("puts the book back when the removal fails", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dune]);
    render(<App />);
    await screen.findByText("1 book");

    removeMock.mockRejectedValue("the disk is read only");
    const tile = screen.getByRole("heading", { name: "Dune" }).closest("li")!;
    await user.click(within(tile).getByRole("button", { name: "Actions for Dune" }));
    await user.click(within(tile).getByRole("menuitem", { name: "Remove from library" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(await screen.findByText("the disk is read only")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Dune" })).toBeInTheDocument();
    expect(screen.getByText("1 book")).toBeInTheDocument();
  });

  it("adds up the failures of overlapping imports", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Your shelf is empty");

    const failures: library.ImportReport[] = [
      { library: [], added: [], errors: [{ name: "a.pdf", message: "not an EPUB file" }] },
      { library: [], added: [], errors: [{ name: "b.pdf", message: "not an EPUB file" }] },
    ];
    openMock.mockResolvedValue("/books/a.epub");
    let call = 0;
    importMock.mockImplementation(async () => failures[call++]);

    const add = screen.getByRole("button", { name: "Add books" });
    await user.click(add);
    await user.click(add);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(/a\.pdf: not an EPUB file/)).toBeInTheDocument();
    expect(within(alert).getByText(/b\.pdf: not an EPUB file/)).toBeInTheDocument();
  });

  it("loads covers only for books that have one", async () => {
    listMock.mockResolvedValue([dune, { ...emma, hasCover: true }]);
    coverMock.mockResolvedValue({ mime: "image/png", base64: "cG5n" });
    render(<App />);

    await screen.findByText("2 books");
    await waitFor(() => expect(coverMock).toHaveBeenCalledTimes(1));
    expect(coverMock).toHaveBeenCalledWith("emma");

    const image = screen.getByRole("presentation", { hidden: true });
    expect(image).toHaveAttribute("src", "data:image/png;base64,cG5n");
  });
});
