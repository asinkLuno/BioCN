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

  it("persists and clamps stored preferences", () => {
    saveReaderPrefs({
      viewMode: "paginated",
      theme: "sepia",
      fontSize: 40,
      lineHeight: 1.0,
      coloringEnabled: false,
      coloringPalette: "soft",
      columns: 2,
    });

    expect(loadReaderPrefs()).toEqual({
      viewMode: "paginated",
      theme: "sepia",
      fontSize: 28,
      lineHeight: 1.4,
      coloringEnabled: false,
      coloringPalette: "soft",
      columns: 2,
    });
  });
});
