/**
 * Lightweight hash router and back-navigation overlay coordinator.
 *
 * Uses `#/...` hash URLs with `window.history.pushState` / `popstate` so:
 * - Tauri desktop & Android production builds never 404 on reload or deep-link.
 * - Android's `WryActivity` (`webView.canGoBack()` -> `webView.goBack()`) and
 *   desktop/browser Back buttons dismiss the topmost modal/drawer or return to
 *   the previous page instead of exiting the app.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

export type Route = { kind: "shelf" } | { kind: "reader"; bookId: string };

interface HistoryPayload {
  __biocn: true;
  depth: number;
  overlayId?: number;
}

interface OverlayEntry {
  id: number;
  depth: number;
  onDismiss: () => void;
  canDismiss: () => boolean;
}

const SHELF_ROUTE: Route = { kind: "shelf" };

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Parses a `location.hash` value into a typed `Route`, falling back to shelf. */
export function parseHash(hash: string): Route {
  const path = (hash.startsWith("#") ? hash.slice(1) : hash).split("?")[0] ?? "";
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return SHELF_ROUTE;

  const parts = trimmed.split("/");
  if (parts.length === 2 && parts[0] === "book") {
    const bookId = safeDecode(parts[1] ?? "").trim();
    if (bookId) return { kind: "reader", bookId };
  }
  return SHELF_ROUTE;
}

/** Formats a typed `Route` into a canonical hash URL. */
export function formatHash(route: Route): string {
  return route.kind === "reader" ? `#/book/${encodeURIComponent(route.bookId)}` : "#/";
}

function routesEqual(a: Route, b: Route): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "shelf" || (b.kind === "reader" && a.bookId === b.bookId);
}

function readPayload(state: unknown): HistoryPayload | null {
  if (typeof state !== "object" || state === null) return null;
  const record = state as Record<string, unknown>;
  if (record.__biocn !== true || typeof record.depth !== "number") return null;
  return {
    __biocn: true,
    depth: record.depth,
    overlayId: typeof record.overlayId === "number" ? record.overlayId : undefined,
  };
}

function makePayload(depth: number, overlayId?: number): HistoryPayload {
  return overlayId === undefined ? { __biocn: true, depth } : { __biocn: true, depth, overlayId };
}

function currentUrl(): string {
  return window.location.hash || window.location.pathname + window.location.search;
}

let initialized = false;
let currentRoute: Route = SHELF_ROUTE;
let currentDepth = 0;
let nextOverlayId = 1;
let activeOverlays: OverlayEntry[] = [];
let pendingRelease: { cancelled: boolean } | null = null;
let inflightSelfPops = 0;
let pendingOps: Array<() => void> = [];
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function syncRouteFromHash() {
  const next = parseHash(window.location.hash);
  if (!routesEqual(currentRoute, next)) {
    currentRoute = next;
    notify();
  }
}

function enqueueOrRun(op: () => void) {
  if (inflightSelfPops > 0) pendingOps.push(op);
  else op();
}

function flushPendingOps() {
  while (inflightSelfPops === 0 && pendingOps.length > 0) {
    pendingOps.shift()!();
  }
}

function cancelPendingRelease(): boolean {
  if (!pendingRelease || pendingRelease.cancelled) return false;
  pendingRelease.cancelled = true;
  pendingRelease = null;
  return true;
}

function dismissPoppedOverlays(newDepth: number): boolean {
  const popped = activeOverlays.filter((entry) => entry.depth > newDepth);
  if (popped.length === 0) return true;

  const blocked = popped.find((entry) => !entry.canDismiss());
  if (blocked) {
    currentDepth = blocked.depth;
    window.history.pushState(makePayload(blocked.depth, blocked.id), "", currentUrl());
    return false;
  }

  const ordered = [...popped].sort((a, b) => b.depth - a.depth);
  const ids = new Set(ordered.map((entry) => entry.id));
  activeOverlays = activeOverlays.filter((entry) => !ids.has(entry.id));
  currentDepth = newDepth;
  for (const entry of ordered) entry.onDismiss();
  return true;
}

function handlePopState() {
  const newDepth = readPayload(window.history.state)?.depth ?? 0;

  if (inflightSelfPops > 0) {
    inflightSelfPops -= 1;
    currentDepth = newDepth;
    syncRouteFromHash();
    flushPendingOps();
    return;
  }

  if (!dismissPoppedOverlays(newDepth)) return;
  currentDepth = newDepth;
  syncRouteFromHash();
}

function handleHashChange() {
  if (inflightSelfPops === 0) syncRouteFromHash();
}

function ensureInitialized() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  currentRoute = parseHash(window.location.hash);
  const existing = readPayload(window.history.state);
  if (existing) {
    currentDepth = existing.depth;
  } else {
    currentDepth = 0;
    const url = window.location.hash ? formatHash(currentRoute) : currentUrl();
    window.history.replaceState(makePayload(0), "", url);
  }
  window.addEventListener("popstate", handlePopState);
  window.addEventListener("hashchange", handleHashChange);
}

/** Pushes a new route onto browser history so Back returns to the previous route. */
export function pushRoute(next: Route): void {
  ensureInitialized();
  enqueueOrRun(() => {
    const reusedSlot = cancelPendingRelease();
    if (!reusedSlot && routesEqual(currentRoute, next) && activeOverlays.length === 0) return;

    if (reusedSlot) {
      window.history.replaceState(makePayload(currentDepth), "", formatHash(next));
    } else {
      currentDepth += 1;
      window.history.pushState(makePayload(currentDepth), "", formatHash(next));
    }
    currentRoute = next;
    notify();
  });
}

/** Replaces the current history entry without adding a new Back step. */
export function replaceRoute(next: Route): void {
  ensureInitialized();
  enqueueOrRun(() => {
    cancelPendingRelease();
    window.history.replaceState(makePayload(currentDepth), "", formatHash(next));
    if (!routesEqual(currentRoute, next)) {
      currentRoute = next;
      notify();
    }
  });
}

/**
 * Navigates back one history entry when this view was reached via in-app
 * navigation (`depth > 0`), preventing Back-button loops. Falls back to
 * replacing with `fallback` when the app launched directly on a deep link.
 */
export function goBackOrReplace(fallback: Route): void {
  ensureInitialized();
  if (cancelPendingRelease()) {
    enqueueOrRun(() => {
      inflightSelfPops += 1;
      window.history.back();
    });
  }
  enqueueOrRun(() => {
    if (currentDepth > 0) window.history.back();
    else replaceRoute(fallback);
  });
}

function acquireOverlay(onDismiss: () => void, canDismiss: () => boolean): number {
  ensureInitialized();
  const id = nextOverlayId++;
  enqueueOrRun(() => {
    const reusedSlot = cancelPendingRelease();
    const depth = reusedSlot ? currentDepth : currentDepth + 1;
    activeOverlays.push({ id, depth, onDismiss, canDismiss });
    currentDepth = depth;
    if (reusedSlot) {
      window.history.replaceState(makePayload(depth, id), "", currentUrl());
    } else {
      window.history.pushState(makePayload(depth, id), "", currentUrl());
    }
  });
  return id;
}

function releaseOverlay(id: number): void {
  ensureInitialized();
  enqueueOrRun(() => {
    const idx = activeOverlays.findIndex((entry) => entry.id === id);
    if (idx < 0) return;
    activeOverlays.splice(idx, 1);

    if (readPayload(window.history.state)?.overlayId !== id) return;

    // Defer the programmatic `history.back()` to a microtask so an immediate
    // follow-up overlay or route push reuses this slot with `replaceState`
    // instead of racing an asynchronous `popstate`.
    const release = { cancelled: false };
    pendingRelease = release;
    queueMicrotask(() => {
      if (release.cancelled) return;
      if (pendingRelease === release) pendingRelease = null;
      enqueueOrRun(() => {
        if (readPayload(window.history.state)?.overlayId !== id) return;
        inflightSelfPops += 1;
        window.history.back();
      });
    });
  });
}

function subscribe(listener: () => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Route {
  ensureInitialized();
  return currentRoute;
}

/** React hook exposing the active URL route and shelf ⇄ reader navigation. */
export function useRouter() {
  const route = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const openBook = useCallback((bookId: string) => {
    pushRoute({ kind: "reader", bookId });
  }, []);
  const closeBook = useCallback(() => {
    goBackOrReplace(SHELF_ROUTE);
  }, []);
  return { route, openBook, closeBook };
}

/**
 * Registers a modal/drawer/popover with browser history while `open` is true so
 * Android/browser Back dismisses it before leaving the underlying route.
 */
export function useHistoryOverlay(open: boolean, onDismiss: () => void, canDismiss = true): void {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const canDismissRef = useRef(canDismiss);
  canDismissRef.current = canDismiss;

  useEffect(() => {
    if (!open) return;
    const id = acquireOverlay(
      () => onDismissRef.current(),
      () => canDismissRef.current,
    );
    return () => releaseOverlay(id);
  }, [open]);
}

/** Resets router singleton state & URL hash between unit tests. */
export function resetRouterForTest(initialHash = ""): void {
  if (typeof window === "undefined") return;
  if (initialized) {
    window.removeEventListener("popstate", handlePopState);
    window.removeEventListener("hashchange", handleHashChange);
  }
  initialized = false;
  cancelPendingRelease();
  activeOverlays = [];
  inflightSelfPops = 0;
  pendingOps = [];
  currentDepth = 0;
  currentRoute = parseHash(initialHash);
  window.history.replaceState(
    makePayload(0),
    "",
    initialHash || window.location.pathname + window.location.search,
  );
}
