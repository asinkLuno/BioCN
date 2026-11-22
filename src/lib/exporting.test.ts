import { describe, expect, it } from "vitest";
import { fileName, fileNameOf } from "./exporting";

describe("fileName", () => {
  it("names the file after the book", () => {
    expect(fileName("Dune")).toBe("Dune.epub");
  });

  it("folds the characters a file system refuses", () => {
    // A subtitle is separated by a colon often enough that refusing to export
    // would read as a bug in the export.
    expect(fileName("Dune: Messiah")).toBe("Dune_ Messiah.epub");
    expect(fileName('A/B\\C*D?E"F<G>H|I')).toBe("A_B_C_D_E_F_G_H_I.epub");
  });

  it("does not hand the OS a hidden or trailing-dot name", () => {
    expect(fileName(".hidden")).toBe("_hidden.epub");
    expect(fileName("Dune...")).toBe("Dune.epub");
    expect(fileName("Dune ")).toBe("Dune.epub");
  });

  it("keeps the name usable when the title is empty or all punctuation", () => {
    expect(fileName("")).toBe("book.epub");
    expect(fileName("///")).toBe("book.epub");
  });

  it("cuts a title too long for a file name", () => {
    const name = fileName("长".repeat(200));
    expect(name).toBe(`${"长".repeat(80)}.epub`);
  });
});

describe("fileNameOf", () => {
  it("takes the last segment of a path", () => {
    expect(fileNameOf("/books/Dune-colored.epub")).toBe("Dune-colored.epub");
    expect(fileNameOf("C:\\books\\Dune.epub")).toBe("Dune.epub");
  });

  it("decodes the document path Android hands back", () => {
    expect(
      fileNameOf("content://com.android.providers.downloads/primary%3ABooks%2FDune.epub"),
    ).toBe("Dune.epub");
  });

  it("keeps a name that is not valid escaping", () => {
    // A literal `%` in a real file name is not an escape, and throwing here
    // would lose the only information the message has.
    expect(fileNameOf("/books/100%.epub")).toBe("100%.epub");
  });
});
