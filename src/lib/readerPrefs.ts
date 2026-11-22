/**
 * Persistent reader appearance and coloring display preferences.
 *
 * Stored in `localStorage` so the initial render applies them synchronously
 * without layout flash.
 */

export type ReaderViewMode = "scrolled" | "paginated";
export type ReaderTheme = "auto" | "light" | "sepia" | "dark";
export type ColoringPalette = "default" | "soft" | "vivid";
export type ReaderColumns = "auto" | 1 | 2;

export interface ReaderPrefs {
  viewMode: ReaderViewMode;
  theme: ReaderTheme;
  fontSize: number;
  lineHeight: number;
  coloringEnabled: boolean;
  coloringPalette: ColoringPalette;
  columns: ReaderColumns;
}

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  viewMode: "scrolled",
  theme: "auto",
  fontSize: 17,
  lineHeight: 1.9,
  coloringEnabled: true,
  coloringPalette: "default",
  columns: "auto",
};

const STORAGE_KEY = "biocn:reader-prefs:v1";

export function loadReaderPrefs(): ReaderPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_READER_PREFS;
    const parsed = JSON.parse(raw) as Partial<ReaderPrefs>;
    return normalizePrefs(parsed);
  } catch {
    return DEFAULT_READER_PREFS;
  }
}

export function saveReaderPrefs(prefs: ReaderPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable (private mode / quota)
  }
}

function normalizePrefs(input: Partial<ReaderPrefs>): ReaderPrefs {
  const viewMode: ReaderViewMode =
    input.viewMode === "paginated" ? "paginated" : "scrolled";
  const theme: ReaderTheme =
    input.theme === "light" || input.theme === "sepia" || input.theme === "dark"
      ? input.theme
      : "auto";
  const coloringPalette: ColoringPalette =
    input.coloringPalette === "soft" || input.coloringPalette === "vivid"
      ? input.coloringPalette
      : "default";
  const columns: ReaderColumns =
    input.columns === 1 || input.columns === 2 ? input.columns : "auto";
  const fontSize =
    typeof input.fontSize === "number" && Number.isFinite(input.fontSize)
      ? Math.max(13, Math.min(28, Math.round(input.fontSize)))
      : DEFAULT_READER_PREFS.fontSize;
  const lineHeight =
    typeof input.lineHeight === "number" && Number.isFinite(input.lineHeight)
      ? Math.max(1.4, Math.min(2.4, Math.round(input.lineHeight * 10) / 10))
      : DEFAULT_READER_PREFS.lineHeight;
  const coloringEnabled =
    typeof input.coloringEnabled === "boolean"
      ? input.coloringEnabled
      : DEFAULT_READER_PREFS.coloringEnabled;

  return {
    viewMode,
    theme,
    fontSize,
    lineHeight,
    coloringEnabled,
    coloringPalette,
    columns,
  };
}
