/**
 * Persistent application chrome theme (`auto` follows the OS color scheme,
 * `light` and `dark` override it via daisyUI's `data-theme` attribute).
 *
 * Stored in `localStorage` so `index.html` and `main.tsx` apply it before
 * first paint with no theme flash.
 */

export type AppTheme = "auto" | "light" | "dark";

export const APP_THEME_STORAGE_KEY = "biocn:app-theme:v1";
const APP_THEME_EVENT = "biocn:app-theme-change";

export function normalizeAppTheme(value: unknown): AppTheme {
  return value === "light" || value === "dark" ? value : "auto";
}

export function loadAppTheme(): AppTheme {
  try {
    return normalizeAppTheme(window.localStorage.getItem(APP_THEME_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

export function saveAppTheme(theme: AppTheme): void {
  try {
    if (theme === "auto") {
      window.localStorage.removeItem(APP_THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(APP_THEME_STORAGE_KEY, theme);
    }
  } catch {
    // Storage unavailable (private mode / quota)
  }
}

export function applyAppTheme(theme: AppTheme): void {
  const root = document.documentElement;
  if (theme === "auto") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
  window.dispatchEvent(new CustomEvent<AppTheme>(APP_THEME_EVENT, { detail: theme }));
}

export function onAppThemeChange(listener: (theme: AppTheme) => void): () => void {
  const handler = (event: Event) => {
    listener(normalizeAppTheme((event as CustomEvent<AppTheme>).detail));
  };
  window.addEventListener(APP_THEME_EVENT, handler);
  return () => window.removeEventListener(APP_THEME_EVENT, handler);
}

export function initAppTheme(): AppTheme {
  const theme = loadAppTheme();
  applyAppTheme(theme);
  return theme;
}
