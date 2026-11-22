/**
 * The reading view: one chapter at a time, served straight from Rust over the
 * `book://` custom URI scheme protocol.
 *
 * Architecture:
 * - Rust (`rbook`) is the single EPUB parser and resource server — no frontend
 *   zip parsing, no full-book fetch, no `blob:` URL rewriting.
 * - Chapters open immediately with whatever sentences are already cached in
 *   SQLite; missing sentences stream in progressively (`chapter://color-patch`)
 *   and are patched in place by the iframe's tiny `bridge.js` without reloading
 *   or shifting scroll position.
 * - The viewport iframe fills `flex-1` natively and supports both vertical
 *   scrolled reading and CSS multi-column paginated reading (1 or 2 columns),
 *   plus live theme / typography / SVO coloring toggles and saved progress.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  bookChapterCancelStream,
  bookChapterColorize,
  bookChapterPrefetch,
  bookOpen,
  bookProgressSave,
  message,
  onChapterColorPatch,
  type BookView,
  type RunPatch,
  type TocEntry,
} from "../lib/reading";
import { bookResourceUrl, resolveRelativeHref } from "../lib/bookProtocol";
import {
  isFrameMessage,
  postToFrame,
  type ChapterTarget,
} from "../lib/readerBridge";
import {
  DEFAULT_SVO_COLORS,
  DEFAULT_SVO_OVERRIDES,
  hasCustomSvoColors,
  loadReaderPrefs,
  saveReaderPrefs,
  type ReaderColumns,
  type ReaderFontFamily,
  type ReaderPageMargin,
  type ReaderPrefs,
  type ReaderTextAlign,
  type ReaderTheme,
  type ReaderViewMode,
  type SvoRole,
} from "../lib/readerPrefs";
import { loadAppTheme, onAppThemeChange, type AppTheme } from "../lib/appTheme";

interface Props {
  id: string;
  /** Called when the reader closes, so the shelf can restore its scroll. */
  onClose: () => void;
  /** Opens settings, for the "download a model" prompt. */
  onOpenSettings: () => void;
  /** Whether settings is on screen above the page. */
  modelsOpen: boolean;
  /** Bumped whenever the active model weights change in settings. */
  modelRevision?: number;
}

interface ChapterProgressState {
  done: number;
  total: number;
  active: boolean;
  missingModel: boolean;
  error: string | null;
}

interface ViewportPosition {
  mode: ReaderViewMode;
  page: number;
  totalPages: number;
  ratio: number;
  paragraphIndex: number | null;
}

interface FrameSlot {
  url: string;
  title: string;
  index: number;
}

type SlotIndex = 0 | 1;

function readerBgClass(theme: ReaderTheme): string {
  switch (theme) {
    case "light":
      return "bg-[#fcfbf8]";
    case "sepia":
      return "bg-[#f4ede0]";
    case "dark":
      return "bg-[#171614]";
    default:
      return "bg-base-100";
  }
}

function TocItem({
  item,
  currentIndex,
  coloredSet,
  onNavigate,
}: {
  item: TocEntry;
  currentIndex: number | null;
  coloredSet: ReadonlySet<number>;
  onNavigate: (chapterIndex: number, anchor: string | null) => void;
}) {
  const isActive = item.chapterIndex !== null && item.chapterIndex === currentIndex && !item.anchor;
  const isColored = item.chapterIndex !== null && coloredSet.has(item.chapterIndex);
  return (
    <li>
      {item.chapterIndex !== null ? (
        <button
          type="button"
          className={isActive ? "menu-active" : undefined}
          onClick={() => onNavigate(item.chapterIndex!, item.anchor)}
        >
          <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
          {isColored && (
            <span
              className="badge badge-xs badge-primary shrink-0"
              title="已完成着色"
              aria-label="已着色"
            />
          )}
        </button>
      ) : (
        <span className="menu-title">{item.label}</span>
      )}
      {item.subitems.length > 0 && (
        <ul>
          {item.subitems.map((child, idx) => (
            <TocItem
              key={`${child.label}-${idx}`}
              item={child}
              currentIndex={currentIndex}
              coloredSet={coloredSet}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Reader({
  id,
  onClose,
  onOpenSettings,
  modelsOpen,
  modelRevision = 0,
}: Props) {
  const [book, setBook] = useState<BookView | null>(null);
  const [index, setIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openAttempt, setOpenAttempt] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadReaderPrefs());
  const [appTheme, setAppTheme] = useState<AppTheme>(() => loadAppTheme());
  useEffect(() => onAppThemeChange(setAppTheme), []);

  // When paper color is set to "auto", follow the explicit app theme (if any)
  // before falling back to OS prefers-color-scheme, so Settings → 外观 keeps
  // the reader chrome and chapter paper seamlessly aligned.
  const effectiveTheme: ReaderTheme =
    prefs.theme === "auto" && appTheme !== "auto" ? appTheme : prefs.theme;
  const effectivePrefs = useMemo<ReaderPrefs>(
    () => (effectiveTheme === prefs.theme ? prefs : { ...prefs, theme: effectiveTheme }),
    [prefs, effectiveTheme],
  );
  const [reloadNonce, setReloadNonce] = useState(0);
  const [colorState, setColorState] = useState<ChapterProgressState>({
    done: 0,
    total: 0,
    active: false,
    missingModel: false,
    error: null,
  });
  const [viewport, setViewport] = useState<ViewportPosition>({
    mode: prefs.viewMode,
    page: 0,
    totalPages: 1,
    ratio: 0,
    paragraphIndex: null,
  });

  // Double-buffered iframe slots: the incoming chapter loads in the hidden
  // staging slot and swaps in atomically only after `bridge.js` finishes layout,
  // theme application, and scroll/page positioning (`painted`), eliminating
  // white flashes between chapters.
  const [slots, setSlots] = useState<[FrameSlot | null, FrameSlot | null]>([null, null]);
  const [activeSlot, setActiveSlot] = useState<SlotIndex>(0);
  const slotRefs = useRef<[HTMLIFrameElement | null, HTMLIFrameElement | null]>([null, null]);
  const slotReadyRef = useRef<[boolean, boolean]>([false, false]);
  const activeSlotRef = useRef<SlotIndex>(0);
  const targetSlotRef = useRef<SlotIndex>(0);
  const swapFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatchesRef = useRef<RunPatch[]>([]);
  const pendingTargetRef = useRef<ChapterTarget>({});
  const prefsRef = useRef(effectivePrefs);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<{
    bookId: string;
    chapterIndex: number;
    paragraphIndex: number | null;
    ratio: number;
  } | null>(null);
  const wasModelsOpen = useRef(modelsOpen);
  const prefsMenuRef = useRef<HTMLDivElement>(null);

  const getCurrentFrame = useCallback(() => {
    const slot = targetSlotRef.current;
    return {
      slot,
      frame: slotRefs.current[slot],
      ready: slotReadyRef.current[slot],
    };
  }, []);

  useEffect(() => {
    saveReaderPrefs(prefs);
  }, [prefs]);

  useEffect(() => {
    prefsRef.current = effectivePrefs;
    for (const slot of [0, 1] as const) {
      if (slotReadyRef.current[slot]) {
        postToFrame(slotRefs.current[slot], {
          source: "biocn-host",
          type: "prefs",
          prefs: effectivePrefs,
        });
      }
    }
  }, [effectivePrefs]);

  const updatePrefs = useCallback((patch: Partial<ReaderPrefs>) => {
    setPrefs((prev) => ({ ...prev, ...patch }));
  }, []);

  // Close appearance popover on outside pointerdown.
  useEffect(() => {
    if (!prefsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!prefsMenuRef.current?.contains(event.target as Node)) {
        setPrefsOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [prefsOpen]);

  // Open book metadata (OPF + TOC + spine + saved progress) — milliseconds.
  useEffect(() => {
    let cancelled = false;
    setBook(null);
    setIndex(null);
    setError(null);
    setLoading(true);
    setSlots([null, null]);
    setActiveSlot(0);
    activeSlotRef.current = 0;
    targetSlotRef.current = 0;
    slotReadyRef.current = [false, false];
    if (swapFallbackRef.current) {
      clearTimeout(swapFallbackRef.current);
      swapFallbackRef.current = null;
    }
    setColorState({
      done: 0,
      total: 0,
      active: false,
      missingModel: false,
      error: null,
    });

    bookOpen(id)
      .then((view) => {
        if (cancelled) return;
        setBook(view);
        if (view.initialChapter === null) {
          setLoading(false);
          setError("这本书没有可阅读的正文。");
          return;
        }
        // Restore saved paragraph/ratio when opening at the saved chapter.
        if (view.progress && view.progress.chapterIndex === view.initialChapter) {
          pendingTargetRef.current = {
            paragraphIndex: view.progress.paragraphIndex,
            ratio: view.progress.ratio,
          };
        } else {
          pendingTargetRef.current = {};
        }
        setIndex(view.initialChapter);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setError(message(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [id, openAttempt]);

  // Reload chapter & retry coloring when returning from settings after model install.
  useEffect(() => {
    if (wasModelsOpen.current && !modelsOpen && colorState.missingModel) {
      setReloadNonce((n) => n + 1);
    }
    wasModelsOpen.current = modelsOpen;
  }, [modelsOpen, colorState.missingModel]);

  // Flush saved progress & cancel any background reader stream on unmount.
  useEffect(() => {
    return () => {
      if (swapFallbackRef.current) {
        clearTimeout(swapFallbackRef.current);
        swapFallbackRef.current = null;
      }
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const pending = lastSavedRef.current;
      if (pending) {
        void bookProgressSave(
          pending.bookId,
          pending.chapterIndex,
          pending.paragraphIndex,
          pending.ratio,
        ).catch(() => {});
      }
      void bookChapterCancelStream().catch(() => {});
    };
  }, []);

  const position = useMemo(() => {
    if (!book || book.id !== id || index === null) return null;
    const at = book.chapters.findIndex((entry) => entry.index === index);
    if (at < 0) return null;
    return {
      at,
      total: book.chapters.length,
      current: book.chapters[at],
      previous: book.chapters[at - 1],
      next: book.chapters[at + 1],
    };
  }, [book, id, index]);

  const coloredSet = useMemo(() => {
    const set = new Set<number>();
    if (book) {
      for (const ch of book.chapters) {
        if (ch.colored) set.add(ch.index);
      }
    }
    return set;
  }, [book]);

  const chapterRevision = modelRevision * 1000 + reloadNonce;
  const currentHref = position?.current.href ?? null;
  const currentTitle = position?.current.title ?? "章节内容";
  const currentChapterIndex = position?.current.index ?? null;
  const chapterUrl = useMemo(() => {
    if (!currentHref) return null;
    // Stamp current appearance preferences into the URL query string so Rust
    // sets `data-theme`/`data-mode`/font CSS vars on `<html>` before first paint.
    return bookResourceUrl(id, currentHref, chapterRevision, prefsRef.current);
  }, [id, currentHref, chapterRevision]);

  const promoteSlot = useCallback((slot: SlotIndex) => {
    if (swapFallbackRef.current) {
      clearTimeout(swapFallbackRef.current);
      swapFallbackRef.current = null;
    }
    const other: SlotIndex = slot === 0 ? 1 : 0;
    activeSlotRef.current = slot;
    slotReadyRef.current[other] = false;
    setActiveSlot(slot);
    setSlots((prev) => (slot === 0 ? [prev[0], null] : [null, prev[1]]));
  }, []);

  // Load each new chapter into the hidden staging slot while the current
  // chapter remains visible; promote atomically once `bridge.js` emits `painted`.
  useEffect(() => {
    if (!chapterUrl || currentChapterIndex === null) return;
    pendingPatchesRef.current = [];

    const nextSlotData: FrameSlot = {
      url: chapterUrl,
      title: currentTitle,
      index: currentChapterIndex,
    };

    setSlots((prev) => {
      const active = activeSlotRef.current;
      // Initial chapter of the book: mount directly into the active slot.
      if (prev[active] === null) {
        targetSlotRef.current = active;
        slotReadyRef.current[active] = false;
        return active === 0 ? [nextSlotData, null] : [null, nextSlotData];
      }
      if (prev[active]?.url === chapterUrl) {
        targetSlotRef.current = active;
        if (swapFallbackRef.current) {
          clearTimeout(swapFallbackRef.current);
          swapFallbackRef.current = null;
        }
        return active === 0 ? [prev[0], null] : [null, prev[1]];
      }
      // Subsequent chapter: load off-screen in the inactive slot so the current
      // page stays painted with zero white flash until the new one is ready.
      const staging: SlotIndex = active === 0 ? 1 : 0;
      targetSlotRef.current = staging;
      slotReadyRef.current[staging] = false;
      if (swapFallbackRef.current) clearTimeout(swapFallbackRef.current);
      swapFallbackRef.current = setTimeout(() => {
        if (targetSlotRef.current === staging) {
          promoteSlot(staging);
        }
      }, 700);
      return staging === 0 ? [nextSlotData, prev[1]] : [prev[0], nextSlotData];
    });
  }, [chapterUrl, currentTitle, currentChapterIndex, promoteSlot]);

  // Trigger P0 progressive coloring for the active chapter and subscribe to patches.
  useEffect(() => {
    if (index === null || !book || book.id !== id) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const markChapterColored = (chapterIdx: number) => {
      setBook((prev) => {
        if (!prev || prev.id !== id) return prev;
        let changed = false;
        const chapters = prev.chapters.map((ch) => {
          if (ch.index === chapterIdx && !ch.colored) {
            changed = true;
            return { ...ch, colored: true };
          }
          return ch;
        });
        return changed ? { ...prev, chapters } : prev;
      });
    };

    void (async () => {
      try {
        const off = await onChapterColorPatch((event) => {
          if (cancelled || event.book !== id || event.chapter !== index) return;
          if (event.patches.length > 0) {
            const { frame, ready } = getCurrentFrame();
            if (ready && frame) {
              postToFrame(frame, {
                source: "biocn-host",
                type: "patch",
                patches: event.patches,
              });
            } else {
              pendingPatchesRef.current.push(...event.patches);
            }
          }
          setColorState({
            done: event.done,
            total: event.total,
            active: !event.finished,
            missingModel: event.missingModel,
            error: event.error,
          });
          if (event.finished && !event.error && !event.missingModel) {
            markChapterColored(index);
          }
        });
        if (cancelled) {
          off();
          return;
        }
        unlisten = off;
      } catch {
        // Event subscription unavailable (e.g. non-Tauri browser preview)
      }

      try {
        const status = await bookChapterColorize(id, index);
        if (cancelled) return;
        setColorState({
          done: status.cachedSentences,
          total: status.totalSentences,
          active: !status.fullyColored && !status.missingModel,
          missingModel: status.missingModel,
          error: null,
        });
        if (status.fullyColored && !status.missingModel) {
          markChapterColored(index);
        }
      } catch (cause: unknown) {
        if (cancelled) return;
        setColorState({
          done: 0,
          total: 0,
          active: false,
          missingModel: false,
          error: message(cause),
        });
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [id, index, book?.id, chapterRevision]);

  // Quietly prefetch (P1) the next chapter once the user settles on the current chapter.
  useEffect(() => {
    const nextChapter = position?.next;
    if (!nextChapter || nextChapter.colored || colorState.missingModel) return;
    const timer = setTimeout(() => {
      void bookChapterPrefetch(id, nextChapter.index).catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, [id, position?.next, colorState.missingModel]);

  const navigateToChapter = useCallback(
    (targetIndex: number, target: ChapterTarget = {}) => {
      if (targetIndex === index) {
        if (target.anchor || target.paragraphIndex !== undefined) {
          postToFrame(getCurrentFrame().frame, {
            source: "biocn-host",
            type: "jump",
            anchor: target.anchor,
            paragraphIndex: target.paragraphIndex,
          });
        }
        return;
      }
      pendingTargetRef.current = target;
      setIndex(targetIndex);
    },
    [index, getCurrentFrame],
  );

  const scheduleProgressSave = useCallback(
    (chapterIndex: number, paragraphIndex: number | null, ratio: number) => {
      lastSavedRef.current = { bookId: id, chapterIndex, paragraphIndex, ratio };
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void bookProgressSave(id, chapterIndex, paragraphIndex, ratio).catch(() => {});
      }, 450);
    },
    [id],
  );

  // Listen for messages from either double-buffered chapter iframe.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isFrameMessage(event.data)) return;
      let senderSlot: SlotIndex | null = null;
      if (slotRefs.current[0] && event.source === slotRefs.current[0].contentWindow) {
        senderSlot = 0;
      } else if (slotRefs.current[1] && event.source === slotRefs.current[1].contentWindow) {
        senderSlot = 1;
      }
      if (senderSlot === null) return;

      const senderFrame = slotRefs.current[senderSlot];
      const isCurrentTarget = senderSlot === targetSlotRef.current;
      const msg = event.data;

      switch (msg.type) {
        case "ready": {
          slotReadyRef.current[senderSlot] = true;
          if (!isCurrentTarget) break;
          postToFrame(senderFrame, {
            source: "biocn-host",
            type: "init",
            prefs: prefsRef.current,
            target: pendingTargetRef.current,
          });
          pendingTargetRef.current = {};
          if (pendingPatchesRef.current.length > 0) {
            postToFrame(senderFrame, {
              source: "biocn-host",
              type: "patch",
              patches: pendingPatchesRef.current,
            });
            pendingPatchesRef.current = [];
          }
          break;
        }
        case "painted": {
          if (isCurrentTarget && senderSlot !== activeSlotRef.current) {
            promoteSlot(senderSlot);
          }
          break;
        }
        case "progress": {
          if (!isCurrentTarget) break;
          setViewport({
            mode: msg.mode,
            page: msg.page,
            totalPages: msg.totalPages,
            ratio: msg.ratio,
            paragraphIndex: msg.paragraphIndex,
          });
          if (index !== null) {
            scheduleProgressSave(index, msg.paragraphIndex, msg.ratio);
          }
          break;
        }
        case "turn": {
          if (!isCurrentTarget) break;
          if (msg.direction === "next" && position?.next) {
            navigateToChapter(position.next.index, { edge: "start" });
          } else if (msg.direction === "prev" && position?.previous) {
            navigateToChapter(position.previous.index, {
              edge: prefsRef.current.viewMode === "paginated" ? "end" : "start",
            });
          }
          break;
        }
        case "link": {
          if (!isCurrentTarget || !position || !book) break;
          const resolved = resolveRelativeHref(position.current.href, msg.href);
          if (!resolved) break;
          const targetChapter = book.chapters.find((ch) => ch.href === resolved.path);
          if (targetChapter) {
            navigateToChapter(targetChapter.index, { anchor: resolved.anchor });
          }
          break;
        }
        case "external": {
          void openUrl(msg.href).catch(() => {});
          break;
        }
        case "key": {
          if (msg.key === "Escape") {
            if (prefsOpen) setPrefsOpen(false);
            else if (tocOpen) setTocOpen(false);
            else onClose();
          }
          break;
        }
        case "tap": {
          if (prefsOpen) {
            setPrefsOpen(false);
          } else {
            setChromeVisible((visible) => !visible);
          }
          break;
        }
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    book,
    index,
    position,
    prefsOpen,
    tocOpen,
    onClose,
    navigateToChapter,
    scheduleProgressSave,
    promoteSlot,
  ]);

  // Host keyboard shortcuts (when focus is outside the iframe).
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
      ) {
        return;
      }
      if (document.querySelector("dialog[open]")) return;

      const { frame, ready } = getCurrentFrame();
      if (event.key === "Escape") {
        if (prefsOpen) setPrefsOpen(false);
        else if (tocOpen) setTocOpen(false);
        else onClose();
      } else if (event.key === "ArrowRight") {
        if (prefs.viewMode === "paginated" && ready && frame) {
          postToFrame(frame, { source: "biocn-host", type: "step", direction: "next" });
        } else if (position?.next) {
          navigateToChapter(position.next.index, { edge: "start" });
        } else {
          return;
        }
      } else if (event.key === "ArrowLeft") {
        if (prefs.viewMode === "paginated" && ready && frame) {
          postToFrame(frame, { source: "biocn-host", type: "step", direction: "prev" });
        } else if (position?.previous) {
          navigateToChapter(position.previous.index, {
            edge: prefs.viewMode === "paginated" ? "end" : "start",
          });
        } else {
          return;
        }
      } else {
        return;
      }
      event.preventDefault();
    },
    [position, prefs.viewMode, prefsOpen, tocOpen, onClose, navigateToChapter, getCurrentFrame],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  const handleStep = (direction: "prev" | "next") => {
    const { frame, ready } = getCurrentFrame();
    if (prefs.viewMode === "paginated" && ready && frame) {
      postToFrame(frame, { source: "biocn-host", type: "step", direction });
      return;
    }
    if (direction === "next" && position?.next) {
      navigateToChapter(position.next.index, { edge: "start" });
    } else if (direction === "prev" && position?.previous) {
      navigateToChapter(position.previous.index, { edge: "start" });
    }
  };

  const canStepPrev =
    prefs.viewMode === "paginated"
      ? viewport.page > 0 || Boolean(position?.previous)
      : Boolean(position?.previous);
  const canStepNext =
    prefs.viewMode === "paginated"
      ? viewport.page < viewport.totalPages - 1 || Boolean(position?.next)
      : Boolean(position?.next);

  const colorPercent =
    colorState.total > 0
      ? Math.min(100, Math.round((colorState.done / colorState.total) * 100))
      : 0;

  // Keep chrome visible while loading or showing an error so the user always
  // has access to back/retry controls.
  const showChrome = chromeVisible || loading || error !== null || tocOpen;

  return (
    <div className="drawer drawer-end h-dvh overflow-hidden bg-base-100 text-base-content">
      <input
        id="reader-toc-drawer"
        type="checkbox"
        className="drawer-toggle"
        checked={tocOpen}
        onChange={(event) => setTocOpen(event.target.checked)}
      />

      <div className="drawer-content relative flex h-dvh flex-col overflow-hidden">
        <header
          aria-hidden={!showChrome}
          className={`absolute inset-x-0 top-0 z-20 border-b border-base-content/10 bg-base-100/95 backdrop-blur transition-all duration-200 ${
            showChrome
              ? "translate-y-0 opacity-100"
              : "pointer-events-none -translate-y-full opacity-0"
          }`}
        >
          <div className="mx-auto flex w-full max-w-5xl items-center gap-1.5 px-2 py-2 sm:px-4">
            <button type="button" className="btn btn-ghost btn-sm gap-1" onClick={onClose}>
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M11.5 5 6.5 10l5 5" />
              </svg>
              书架
            </button>

            <div className="min-w-0 flex-1 text-center">
              <p className="truncate text-sm font-medium">
                {book?.id === id ? book.title : "正在打开…"}
              </p>
              <div className="flex items-center justify-center gap-2 text-xs text-base-content/55">
                {position?.current.title && (
                  <span className="truncate">{position.current.title}</span>
                )}
                {colorState.active && (
                  <span
                    role="status"
                    aria-label="本章着色进度"
                    className="badge badge-soft badge-primary badge-xs gap-1 shrink-0"
                  >
                    <span className="loading loading-spinner loading-xs size-2.5" />
                    着色 {colorPercent}%
                  </span>
                )}
                {colorState.missingModel && (
                  <button
                    type="button"
                    className="badge badge-soft badge-warning badge-xs cursor-pointer shrink-0 hover:badge-warning"
                    onClick={onOpenSettings}
                  >
                    下载模型以启用着色
                  </button>
                )}
              </div>
            </div>

            <button
              type="button"
              className={`btn btn-sm ${prefs.coloringEnabled ? "btn-soft btn-primary" : "btn-ghost"}`}
              aria-pressed={prefs.coloringEnabled}
              title={prefs.coloringEnabled ? "关闭主谓宾着色" : "开启主谓宾着色"}
              onClick={() => updatePrefs({ coloringEnabled: !prefs.coloringEnabled })}
            >
              着色
            </button>

            <div ref={prefsMenuRef} className={`dropdown dropdown-end ${prefsOpen ? "dropdown-open" : ""}`}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label="阅读设置"
                aria-expanded={prefsOpen}
                onClick={() => setPrefsOpen((open) => !open)}
              >
                Aa
              </button>
              {prefsOpen && (
                <div className="dropdown-content card z-30 mt-2 max-h-[calc(100dvh-5rem)] w-72 overflow-y-auto bg-base-100 shadow-xl ring-1 ring-base-content/10">
                  <div className="card-body gap-3 p-4 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-base-content/70">翻页方式</span>
                      <div className="join">
                        {(
                          [
                            ["scrolled", "滚动"],
                            ["paginated", "分页"],
                          ] as [ReaderViewMode, string][]
                        ).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            className={`btn btn-xs join-item ${prefs.viewMode === mode ? "btn-primary" : "btn-ghost"}`}
                            onClick={() => updatePrefs({ viewMode: mode })}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {prefs.viewMode === "paginated" && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-base-content/70">栏数</span>
                        <div className="join">
                          {(
                            [
                              ["auto", "自动"],
                              [1, "单栏"],
                              [2, "双栏"],
                            ] as [ReaderColumns, string][]
                          ).map(([cols, label]) => (
                            <button
                              key={String(cols)}
                              type="button"
                              className={`btn btn-xs join-item ${prefs.columns === cols ? "btn-primary" : "btn-ghost"}`}
                              onClick={() => updatePrefs({ columns: cols })}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-base-content/70">纸色</span>
                      <div className="join">
                        {(
                          [
                            ["auto", "自动"],
                            ["light", "亮"],
                            ["sepia", "纸"],
                            ["dark", "暗"],
                          ] as [ReaderTheme, string][]
                        ).map(([theme, label]) => (
                          <button
                            key={theme}
                            type="button"
                            className={`btn btn-xs join-item ${prefs.theme === theme ? "btn-primary" : "btn-ghost"}`}
                            onClick={() => updatePrefs({ theme })}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-base-content/70">字体</span>
                      <div className="join">
                        {(
                          [
                            ["default", "默认"],
                            ["serif", "思源宋体"],
                          ] as [ReaderFontFamily, string][]
                        ).map(([fontFamily, label]) => (
                          <button
                            key={fontFamily}
                            type="button"
                            className={`btn btn-xs join-item ${prefs.fontFamily === fontFamily ? "btn-primary" : "btn-ghost"}`}
                            onClick={() => updatePrefs({ fontFamily })}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-base-content/70">字号</span>
                        <span className="text-xs tabular-nums text-base-content/60">
                          {prefs.fontSize}px
                        </span>
                      </div>
                      <input
                        type="range"
                        aria-label="字号"
                        min={13}
                        max={28}
                        step={1}
                        value={prefs.fontSize}
                        onChange={(event) =>
                          updatePrefs({ fontSize: Number(event.target.value) })
                        }
                        className="range range-xs range-primary"
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-base-content/70">行距</span>
                        <span className="text-xs tabular-nums text-base-content/60">
                          {prefs.lineHeight.toFixed(1)}
                        </span>
                      </div>
                      <input
                        type="range"
                        aria-label="行距"
                        min={1.4}
                        max={2.4}
                        step={0.1}
                        value={prefs.lineHeight}
                        onChange={(event) =>
                          updatePrefs({ lineHeight: Number(event.target.value) })
                        }
                        className="range range-xs range-primary"
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-base-content/70">段间距</span>
                        <span className="text-xs tabular-nums text-base-content/60">
                          {prefs.paragraphSpacing.toFixed(1)}em
                        </span>
                      </div>
                      <input
                        type="range"
                        aria-label="段间距"
                        min={0.4}
                        max={2.0}
                        step={0.2}
                        value={prefs.paragraphSpacing}
                        onChange={(event) =>
                          updatePrefs({ paragraphSpacing: Number(event.target.value) })
                        }
                        className="range range-xs range-primary"
                      />
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-base-content/70">页边距</span>
                      <div className="join">
                        {(
                          [
                            ["compact", "窄"],
                            ["normal", "适中"],
                            ["wide", "宽"],
                          ] as [ReaderPageMargin, string][]
                        ).map(([pageMargin, label]) => (
                          <button
                            key={pageMargin}
                            type="button"
                            className={`btn btn-xs join-item ${prefs.pageMargin === pageMargin ? "btn-primary" : "btn-ghost"}`}
                            onClick={() => updatePrefs({ pageMargin })}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-base-content/70">对齐</span>
                      <div className="join">
                        {(
                          [
                            ["default", "默认"],
                            ["justify", "两端对齐"],
                          ] as [ReaderTextAlign, string][]
                        ).map(([textAlign, label]) => (
                          <button
                            key={textAlign}
                            type="button"
                            className={`btn btn-xs join-item ${prefs.textAlign === textAlign ? "btn-primary" : "btn-ghost"}`}
                            onClick={() => updatePrefs({ textAlign })}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-base-content/70">翻页动画</span>
                      <input
                        type="checkbox"
                        aria-label="翻页动画开关"
                        className="toggle toggle-primary toggle-sm"
                        checked={prefs.pageAnimation}
                        onChange={(event) =>
                          updatePrefs({ pageAnimation: event.target.checked })
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-base-content/70">深色插图护眼</span>
                      <input
                        type="checkbox"
                        aria-label="深色插图护眼开关"
                        className="toggle toggle-primary toggle-sm"
                        checked={prefs.dimImagesInDark}
                        onChange={(event) =>
                          updatePrefs({ dimImagesInDark: event.target.checked })
                        }
                      />
                    </div>

                    <div className="divider my-0" />

                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-base-content/70">主谓宾着色</span>
                      <input
                        type="checkbox"
                        aria-label="主谓宾着色开关"
                        className="toggle toggle-primary toggle-sm"
                        checked={prefs.coloringEnabled}
                        onChange={(event) =>
                          updatePrefs({ coloringEnabled: event.target.checked })
                        }
                      />
                    </div>

                    {prefs.coloringEnabled && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-base-content/70">颜色</span>
                          {hasCustomSvoColors(prefs.svoColors) && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs h-6 min-h-6 px-1.5 text-base-content/60"
                              onClick={() => updatePrefs({ svoColors: DEFAULT_SVO_OVERRIDES })}
                            >
                              恢复默认
                            </button>
                          )}
                        </div>
                        <div className="grid grid-cols-3 gap-1.5">
                          {(
                            [
                              ["subject", "主语"],
                              ["predicate", "谓语"],
                              ["object", "宾语"],
                            ] as [SvoRole, string][]
                          ).map(([role, label]) => {
                            const resolvedPaper: "light" | "sepia" | "dark" =
                              effectiveTheme === "sepia"
                                ? "sepia"
                                : effectiveTheme === "dark" ||
                                    (effectiveTheme === "auto" &&
                                      typeof window !== "undefined" &&
                                      window.matchMedia?.("(prefers-color-scheme: dark)").matches)
                                  ? "dark"
                                  : "light";
                            const color =
                              prefs.svoColors[role] ?? DEFAULT_SVO_COLORS[resolvedPaper][role];
                            return (
                              <label
                                key={role}
                                className="btn btn-xs btn-ghost relative h-7 min-h-7 justify-center gap-1.5 border border-base-content/15 font-normal"
                              >
                                <span
                                  aria-hidden="true"
                                  className="size-2.5 shrink-0 rounded-full"
                                  style={{ backgroundColor: color }}
                                />
                                <span>{label}</span>
                                <input
                                  type="color"
                                  aria-label={`${label}颜色`}
                                  value={color}
                                  onChange={(event) =>
                                    updatePrefs({
                                      svoColors: {
                                        ...prefs.svoColors,
                                        [role]: event.target.value,
                                      },
                                    })
                                  }
                                  className="sr-only"
                                />
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-expanded={tocOpen}
              onClick={() => setTocOpen((open) => !open)}
            >
              目录
            </button>
          </div>
          {colorState.active && (
            <progress
              className="progress progress-primary block h-0.5 w-full rounded-none"
              value={colorState.done}
              max={Math.max(colorState.total, 1)}
            />
          )}
        </header>

        {colorState.error && (
          <div className="absolute inset-x-0 top-14 z-10 mx-auto w-full max-w-3xl px-4">
            <div role="alert" className="alert alert-warning alert-soft py-2 text-xs shadow">
              <span className="flex-1 break-words">
                本章着色暂时失败（仍可阅读原文）：{colorState.error}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => setReloadNonce((n) => n + 1)}
              >
                重试着色
              </button>
            </div>
          </div>
        )}

        <main
          className={`relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden transition-colors duration-200 ${readerBgClass(effectiveTheme)}`}
          aria-busy={loading}
        >
          {error !== null ? (
            <div role="alert" className="alert alert-error mx-auto mt-20 max-w-3xl items-start">
              <div className="min-w-0 flex-1">
                <p className="font-medium">无法打开这本书</p>
                <p className="mt-1 text-sm break-words opacity-80">{error}</p>
              </div>
              <button
                type="button"
                className="btn btn-sm shrink-0"
                onClick={() => setOpenAttempt((n) => n + 1)}
              >
                重试
              </button>
            </div>
          ) : loading || chapterUrl === null ? (
            <div className="mx-auto w-full max-w-3xl space-y-4 px-6 pt-20">
              {Array.from({ length: 8 }, (_, line) => (
                <div
                  key={line}
                  className="skeleton h-4 rounded"
                  style={{ width: `${[100, 96, 99, 88, 100, 94, 72, 100][line]}%` }}
                />
              ))}
            </div>
          ) : (
            ([0, 1] as const).map((slot) => {
              const item = slots[slot];
              if (!item) return null;
              const isActive = activeSlot === slot;
              return (
                <iframe
                  key={slot}
                  ref={(el) => {
                    slotRefs.current[slot] = el;
                  }}
                  src={item.url}
                  title={item.title}
                  aria-hidden={!isActive}
                  className={`absolute inset-0 block h-full w-full border-0 bg-transparent ${
                    isActive ? "z-10 opacity-100" : "pointer-events-none z-0 opacity-0"
                  }`}
                />
              );
            })
          )}
        </main>

        <footer
          aria-hidden={!showChrome}
          className={`absolute inset-x-0 bottom-0 z-20 border-t border-base-content/10 bg-base-100/95 backdrop-blur transition-all duration-200 ${
            showChrome
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-full opacity-0"
          }`}
        >
          <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-2 py-2 sm:px-4">
            <button
              type="button"
              className="btn btn-ghost btn-sm shrink-0"
              disabled={!canStepPrev}
              onClick={() => handleStep("prev")}
            >
              {prefs.viewMode === "paginated" ? "上一页" : "上一章"}
            </button>

            <div className="flex min-w-0 flex-1 items-center gap-3">
              <input
                type="range"
                aria-label="本章阅读进度"
                min={0}
                max={100}
                value={Math.round(viewport.ratio * 100)}
                disabled={!position}
                onChange={(event) => {
                  const ratio = Number(event.target.value) / 100;
                  setViewport((prev) => ({ ...prev, ratio }));
                  postToFrame(getCurrentFrame().frame, { source: "biocn-host", type: "seek", ratio });
                }}
                className="range range-xs hidden flex-1 sm:block"
              />
              <p className="w-full shrink-0 text-center text-xs tabular-nums text-base-content/55 sm:w-auto">
                {position
                  ? prefs.viewMode === "paginated"
                    ? `${viewport.page + 1}/${viewport.totalPages} 页 · ${position.at + 1}/${position.total} 章`
                    : `${Math.round(viewport.ratio * 100)}% · ${position.at + 1}/${position.total} 章`
                  : ""}
              </p>
            </div>

            <button
              type="button"
              className="btn btn-ghost btn-sm shrink-0"
              disabled={!canStepNext}
              onClick={() => handleStep("next")}
            >
              {prefs.viewMode === "paginated" ? "下一页" : "下一章"}
            </button>
          </div>
        </footer>
      </div>

      <div className="drawer-side z-40">
        <label
          htmlFor="reader-toc-drawer"
          aria-label="关闭目录"
          className="drawer-overlay"
        />
        <nav
          aria-label="章节目录"
          className="flex h-full w-80 max-w-[85vw] flex-col bg-base-100 text-base-content shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-base-content/10 px-4 py-3">
            <h2 className="text-sm font-semibold">目录</h2>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => setTocOpen(false)}
            >
              关闭
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
            {book && (
              <ul className="menu w-full flex-nowrap">
                {book.toc.length > 0
                  ? book.toc.map((entry, idx) => (
                      <TocItem
                        key={`${entry.label}-${idx}`}
                        item={entry}
                        currentIndex={index}
                        coloredSet={coloredSet}
                        onNavigate={(chapterIndex, anchor) => {
                          navigateToChapter(chapterIndex, { anchor });
                          setTocOpen(false);
                        }}
                      />
                    ))
                  : book.chapters.map((entry) => (
                      <li key={entry.index}>
                        <button
                          type="button"
                          className={entry.index === index ? "menu-active" : undefined}
                          onClick={() => {
                            navigateToChapter(entry.index, { edge: "start" });
                            setTocOpen(false);
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate text-left">
                            {entry.title ?? `第 ${entry.index + 1} 节`}
                          </span>
                          {entry.colored && (
                            <span
                              className="badge badge-xs badge-primary shrink-0"
                              title="已完成着色"
                              aria-label="已着色"
                            />
                          )}
                        </button>
                      </li>
                    ))}
              </ul>
            )}
          </div>
        </nav>
      </div>
    </div>
  );
}
