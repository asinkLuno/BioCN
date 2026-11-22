import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_READER_PREFS,
  loadReaderPrefs,
  saveReaderPrefs,
} from "./readerPrefs";

describe("readerPrefs", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadReaderPrefs()).toEqual(DEFAULT_READER_PREFS);
  });

  it("persists, clamps, and normalizes stored preferences", () => {
    saveReaderPrefs({
      viewMode: "paginated",
      theme: "sepia",
      fontFamily: "serif",
      fontSize: 40,
      lineHeight: 1.0,
      paragraphSpacing: 3.5,
      pageMargin: "wide",
      textAlign: "justify",
      pageAnimation: false,
      dimImagesInDark: false,
      coloringEnabled: false,
      svoColors: { subject: "#D95F02", predicate: "bad", object: null },
      columns: 2,
    });

    expect(loadReaderPrefs()).toEqual({
      viewMode: "paginated",
      theme: "sepia",
      fontFamily: "serif",
      fontSize: 28,
      lineHeight: 1.4,
      paragraphSpacing: 2.0,
      pageMargin: "wide",
      textAlign: "justify",
      pageAnimation: false,
      dimImagesInDark: false,
      coloringEnabled: false,
      svoColors: { subject: "#d95f02", predicate: null, object: null },
      columns: 2,
    });
  });
});
