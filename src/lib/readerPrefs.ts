/**
 * Persistent reader appearance and coloring display preferences.
 *
 * Stored in `localStorage` so the initial render applies them synchronously
 * without layout flash.
 */

export type ReaderViewMode = "scrolled" | "paginated";
export type ReaderTheme = "auto" | "light" | "sepia" | "dark";
export type ReaderColumns = "auto" | 1 | 2;
export type ReaderFontFamily = "default" | "serif";
export type ReaderPageMargin = "compact" | "normal" | "wide";
export type ReaderTextAlign = "default" | "justify";
export type SvoRole = "subject" | "predicate" | "object";

/** Custom hex overrides (`#rrggbb`), or `null` to use the theme-aware defaults. */
export interface SvoColors {
  subject: string | null;
  predicate: string | null;
  object: string | null;
}

export const DEFAULT_SVO_COLORS: Record<"light" | "sepia" | "dark", Record<SvoRole, string>> = {
  light: { subject: "#c04e08", predicate: "#137a5b", object: "#635ba6" },
  sepia: { subject: "#b34808", predicate: "#147054", object: "#5b5299" },
  dark: { subject: "#ea9558", predicate: "#58c4a3", object: "#aba0eb" },
};

export interface ReaderPrefs {
  viewMode: ReaderViewMode;
  theme: ReaderTheme;
  fontFamily: ReaderFontFamily;
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  pageMargin: ReaderPageMargin;
  textAlign: ReaderTextAlign;
  pageAnimation: boolean;
  dimImagesInDark: boolean;
  coloringEnabled: boolean;
  svoColors: SvoColors;
  columns: ReaderColumns;
}

export const DEFAULT_SVO_OVERRIDES: SvoColors = {
  subject: null,
  predicate: null,
  object: null,
};

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  viewMode: "scrolled",
  theme: "auto",
  fontFamily: "default",
  fontSize: 17,
  lineHeight: 1.9,
  paragraphSpacing: 0.8,
  pageMargin: "normal",
  textAlign: "default",
  pageAnimation: true,
  dimImagesInDark: true,
  coloringEnabled: true,
  svoColors: DEFAULT_SVO_OVERRIDES,
  columns: "auto",
};

const STORAGE_KEY = "biocn:reader-prefs:v1";
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function normalizeHexColor(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOR_RE.test(value) ? value.toLowerCase() : null;
}

export function hasCustomSvoColors(colors: SvoColors): boolean {
  return colors.subject !== null || colors.predicate !== null || colors.object !== null;
}

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
  const fontFamily: ReaderFontFamily =
    input.fontFamily === "serif" ? "serif" : "default";
  const pageMargin: ReaderPageMargin =
    input.pageMargin === "compact" || input.pageMargin === "wide"
      ? input.pageMargin
      : "normal";
  const textAlign: ReaderTextAlign =
    input.textAlign === "justify" ? "justify" : "default";
  const pageAnimation =
    typeof input.pageAnimation === "boolean"
      ? input.pageAnimation
      : DEFAULT_READER_PREFS.pageAnimation;
  const dimImagesInDark =
    typeof input.dimImagesInDark === "boolean"
      ? input.dimImagesInDark
      : DEFAULT_READER_PREFS.dimImagesInDark;
  const rawColors = input.svoColors;
  const svoColors: SvoColors = {
    subject: normalizeHexColor(rawColors?.subject),
    predicate: normalizeHexColor(rawColors?.predicate),
    object: normalizeHexColor(rawColors?.object),
  };
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
  const paragraphSpacing =
    typeof input.paragraphSpacing === "number" && Number.isFinite(input.paragraphSpacing)
      ? Math.max(0.4, Math.min(2.0, Math.round(input.paragraphSpacing * 10) / 10))
      : DEFAULT_READER_PREFS.paragraphSpacing;
  const coloringEnabled =
    typeof input.coloringEnabled === "boolean"
      ? input.coloringEnabled
      : DEFAULT_READER_PREFS.coloringEnabled;

  return {
    viewMode,
    theme,
    fontFamily,
    fontSize,
    lineHeight,
    paragraphSpacing,
    pageMargin,
    textAlign,
    pageAnimation,
    dimImagesInDark,
    coloringEnabled,
    svoColors,
    columns,
  };
}
