import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_THEME_STORAGE_KEY,
  applyAppTheme,
  initAppTheme,
  loadAppTheme,
  onAppThemeChange,
  saveAppTheme,
} from "./appTheme";

describe("appTheme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("defaults to auto and falls back on unknown values", () => {
    expect(loadAppTheme()).toBe("auto");
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, "sepia");
    expect(loadAppTheme()).toBe("auto");
  });

  it("persists light/dark and clears storage on auto", () => {
    saveAppTheme("dark");
    expect(loadAppTheme()).toBe("dark");
    saveAppTheme("light");
    expect(loadAppTheme()).toBe("light");
    saveAppTheme("auto");
    expect(loadAppTheme()).toBe("auto");
    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBeNull();
  });

  it("applies and removes data-theme on documentElement", () => {
    applyAppTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    applyAppTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    applyAppTheme("auto");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("initializes from saved preference", () => {
    saveAppTheme("dark");
    expect(initAppTheme()).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("notifies listeners when theme changes", () => {
    const listener = vi.fn();
    const unsubscribe = onAppThemeChange(listener);
    applyAppTheme("dark");
    applyAppTheme("auto");
    unsubscribe();
    applyAppTheme("light");
    expect(listener.mock.calls).toEqual([["dark"], ["auto"]]);
  });
});
