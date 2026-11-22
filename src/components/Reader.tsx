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

import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AppTheme, loadAppTheme, onAppThemeChange } from "../lib/appTheme";
import { bookResourceUrl, resolveRelativeHref } from "../lib/bookProtocol";
import {
  collectTocAnchors,
  hasVisibleFootnoteContent,
  looksLikeFootnoteHref,
  parseFootnoteHtml,
} from "../lib/footnote";
import { type ChapterTarget, isFrameMessage, postToFrame } from "../lib/readerBridge";
import {
  loadReaderPrefs,
  type ReaderPrefs,
  type ReaderTheme,
  type ReaderViewMode,
  saveReaderPrefs,
} from "../lib/readerPrefs";
import {
  type BookView,
  bookChapterCancelStream,
  bookChapterColorize,
  bookChapterPrefetch,
  bookOpen,
  bookProgressSave,
  message,
  onChapterColorPatch,
  type RunPatch,
} from "../lib/reading";
import { useHistoryOverlay } from "../lib/router";
import { type FootnoteView, ReaderFootnoteDialog } from "./ReaderFootnoteDialog";
import { ReaderPrefsPopover } from "./ReaderPrefsPopover";
import { ReaderTocDrawer } from "./ReaderTocDrawer";

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

const INITIAL_COLOR_STATE: ChapterProgressState = {
  done: 0,
  total: 0,
  active: false,
  missingModel: false,
  error: null,
};

const SKELETON_LINE_WIDTHS = [
  { id: "l1", width: 100 },
  { id: "l2", width: 96 },
  { id: "l3", width: 99 },
  { id: "l4", width: 88 },
  { id: "l5", width: 100 },
  { id: "l6", width: 94 },
  { id: "l7", width: 72 },
  { id: "l8", width: 100 },
] as const;

/**
 * Paper backdrop matched to `src-tauri/src/protocol/reader.css` so the host
 * surface behind the iframe never flashes a mismatched color between chapters.
 * Kept minimal because daisyUI has no sepia paper token.
 */
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

export function Reader({ id, onClose, onOpenSettings, modelsOpen, modelRevision = 0 }: Props) {
  const [book, setBook] = useState<BookView | null>(null);
  const [index, setIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openAttempt, setOpenAttempt] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [footnote, setFootnote] = useState<FootnoteView | null>(null);
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
  const [colorState, setColorState] = useState<ChapterProgressState>(INITIAL_COLOR_STATE);
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
  const slotsRef = useRef<[FrameSlot | null, FrameSlot | null]>([null, null]);
  const slotRefs = useRef<[HTMLIFrameElement | null, HTMLIFrameElement | null]>([null, null]);
  const slotReadyRef = useRef<[boolean, boolean]>([false, false]);
  const activeSlotRef = useRef<SlotIndex>(0);
  const targetSlotRef = useRef<SlotIndex>(0);
  const swapFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatchesRef = useRef<RunPatch[]>([]);
  const pendingTargetRef = useRef<ChapterTarget>({});
  const footnoteReqSeqRef = useRef(0);
  const footnoteRequestRef = useRef<{
    id: number;
    timer: ReturnType<typeof setTimeout>;
    fallback: () => void;
    targetChapterIndex: number | null;
    baseHref: string;
  } | null>(null);
  const prefsRef = useRef(effectivePrefs);
  // Keep latest effective prefs visible synchronously to chapterUrl and message handlers.
  prefsRef.current = effectivePrefs;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const colorActiveRef = useRef(false);
  colorActiveRef.current = colorState.active;
  const needsReloadOnColorOnRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<{
    bookId: string;
    chapterIndex: number;
    paragraphIndex: number | null;
    ratio: number;
    dirty: boolean;
  } | null>(null);
  const prefsMenuRef = useRef<HTMLDivElement>(null);

  const clearPendingFootnoteRequest = useCallback(() => {
    if (footnoteRequestRef.current) {
      clearTimeout(footnoteRequestRef.current.timer);
      footnoteRequestRef.current = null;
    }
  }, []);

  const openFootnotePopup = useCallback(
    (params: {
      label: string;
      html: string;
      baseHref: string;
      targetChapterIndex: number | null;
      targetAnchor: string;
      sameChapter: boolean;
    }): boolean => {
      const nodes = parseFootnoteHtml(params.html, {
        bookId: id,
        baseHref: params.baseHref,
      });
      if (!hasVisibleFootnoteContent(nodes)) return false;
      setPrefsOpen(false);
      setFootnote({
        label: params.label,
        nodes,
        targetChapterIndex: params.targetChapterIndex,
        targetAnchor: params.targetAnchor,
        sameChapter: params.sameChapter,
      });
      return true;
    },
    [id],
  );

  const flushProgress = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = lastSavedRef.current;
    if (pending && pending.dirty) {
      pending.dirty = false;
      void bookProgressSave(
        pending.bookId,
        pending.chapterIndex,
        pending.paragraphIndex,
        pending.ratio,
      ).catch(() => {});
    }
  }, []);

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
    void openAttempt;
    let cancelled = false;
    flushProgress();
    clearPendingFootnoteRequest();
    setFootnote(null);
    needsReloadOnColorOnRef.current = false;
    lastSavedRef.current = null;
    setBook(null);
    setIndex(null);
    setError(null);
    setLoading(true);
    slotsRef.current = [null, null];
    setSlots([null, null]);
    setActiveSlot(0);
    activeSlotRef.current = 0;
    targetSlotRef.current = 0;
    slotReadyRef.current = [false, false];
    if (swapFallbackRef.current) {
      clearTimeout(swapFallbackRef.current);
      swapFallbackRef.current = null;
    }
    setColorState(INITIAL_COLOR_STATE);

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
  }, [id, openAttempt, flushProgress, clearPendingFootnoteRequest]);

  // Refresh chapter coloring badges & hasModel when the user installs, switches,
  // or removes a model in Settings without losing their current chapter/position.
  useEffect(() => {
    if (modelRevision === 0) return;
    let cancelled = false;
    bookOpen(id)
      .then((view) => {
        if (cancelled) return;
        setBook((prev) =>
          prev && prev.id === id
            ? { ...prev, hasModel: view.hasModel, chapters: view.chapters }
            : prev,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, modelRevision]);

  // Flush unsaved progress & cancel any background reader stream on unmount.
  useEffect(() => {
    return () => {
      if (swapFallbackRef.current) {
        clearTimeout(swapFallbackRef.current);
        swapFallbackRef.current = null;
      }
      clearPendingFootnoteRequest();
      flushProgress();
      void bookChapterCancelStream().catch(() => {});
    };
  }, [flushProgress, clearPendingFootnoteRequest]);

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

  const tocAnchors = useMemo(
    () => (book ? collectTocAnchors(book.toc, book.chapters) : new Set<string>()),
    [book],
  );

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
    const prev = slotsRef.current;
    const next: [FrameSlot | null, FrameSlot | null] =
      slot === 0 ? [prev[0], null] : [null, prev[1]];
    slotsRef.current = next;
    setActiveSlot(slot);
    setSlots(next);
  }, []);

  // Load each new chapter into the hidden staging slot while the current
  // chapter remains visible; promote atomically once `bridge.js` emits `painted`.
  // All ref mutations and timer scheduling happen here (never inside setSlots).
  useEffect(() => {
    if (!chapterUrl || currentChapterIndex === null) return;
    pendingPatchesRef.current = [];

    const nextSlotData: FrameSlot = {
      url: chapterUrl,
      title: currentTitle,
      index: currentChapterIndex,
    };

    const prev = slotsRef.current;
    const active = activeSlotRef.current;
    if (swapFallbackRef.current) {
      clearTimeout(swapFallbackRef.current);
      swapFallbackRef.current = null;
    }

    let next: [FrameSlot | null, FrameSlot | null];
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    if (prev[active] === null) {
      // Initial chapter of the book: mount directly into the active slot.
      targetSlotRef.current = active;
      slotReadyRef.current[active] = false;
      next = active === 0 ? [nextSlotData, null] : [null, nextSlotData];
    } else if (prev[active]?.url === chapterUrl) {
      targetSlotRef.current = active;
      next = active === 0 ? [prev[0], null] : [null, prev[1]];
    } else {
      // Subsequent chapter: load off-screen in the inactive slot so the current
      // page stays painted with zero white flash until the new one is ready.
      const staging: SlotIndex = active === 0 ? 1 : 0;
      targetSlotRef.current = staging;
      slotReadyRef.current[staging] = false;
      fallbackTimer = setTimeout(() => {
        if (targetSlotRef.current === staging) {
          promoteSlot(staging);
        }
      }, 700);
      swapFallbackRef.current = fallbackTimer;
      next = staging === 0 ? [nextSlotData, prev[1]] : [prev[0], nextSlotData];
    }

    slotsRef.current = next;
    setSlots(next);

    return () => {
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        if (swapFallbackRef.current === fallbackTimer) {
          swapFallbackRef.current = null;
        }
      }
    };
  }, [chapterUrl, currentTitle, currentChapterIndex, promoteSlot]);

  const loadedBookId = book?.id ?? null;

  // Trigger P0 progressive coloring for the active chapter and subscribe to patches.
  // Respect `prefs.coloringEnabled`: when turned off, cancel any running stream
  // and skip analysis/prefetch instead of continuing to color in the background.
  useEffect(() => {
    void chapterRevision;
    if (index === null || loadedBookId !== id) return;
    if (!prefs.coloringEnabled) {
      if (colorActiveRef.current) {
        needsReloadOnColorOnRef.current = true;
      }
      setColorState(INITIAL_COLOR_STATE);
      void bookChapterCancelStream().catch(() => {});
      return;
    }
    if (needsReloadOnColorOnRef.current) {
      needsReloadOnColorOnRef.current = false;
      pendingTargetRef.current = {
        paragraphIndex: viewportRef.current.paragraphIndex,
        ratio: viewportRef.current.ratio,
      };
      setReloadNonce((n) => n + 1);
      return;
    }
    let cancelled = false;
    let receivedPatch = false;
    let unlisten: (() => void) | undefined;

    // Reset immediately on chapter switch so the previous chapter's progress
    // badge or error alert never lingers while the new IPC call is in flight.
    setColorState(INITIAL_COLOR_STATE);

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
          receivedPatch = true;
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
        // Guard against a fast `chapter://color-patch` (including `finished: true`)
        // that arrived before this initial IPC snapshot resolved.
        if (!receivedPatch) {
          setColorState({
            done: status.cachedSentences,
            total: status.totalSentences,
            active: !status.fullyColored && !status.missingModel,
            missingModel: status.missingModel,
            error: null,
          });
        }
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
  }, [id, index, loadedBookId, chapterRevision, prefs.coloringEnabled, getCurrentFrame]);

  // Quietly prefetch (P2) the next chapter once the user settles on the current chapter.
  useEffect(() => {
    const nextChapter = position?.next;
    if (!prefs.coloringEnabled || !nextChapter || nextChapter.colored || colorState.missingModel) {
      return;
    }
    const timer = setTimeout(() => {
      void bookChapterPrefetch(id, nextChapter.index).catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, [id, position?.next, colorState.missingModel, prefs.coloringEnabled]);

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
      clearPendingFootnoteRequest();
      setFootnote(null);
      needsReloadOnColorOnRef.current = false;
      pendingTargetRef.current = target;
      setIndex(targetIndex);
    },
    [index, getCurrentFrame, clearPendingFootnoteRequest],
  );

  const handleTocNavigate = useCallback(
    (chapterIndex: number, anchor: string | null) => {
      navigateToChapter(chapterIndex, anchor ? { anchor } : { edge: "start" });
      setTocOpen(false);
    },
    [navigateToChapter],
  );

  const closeToc = useCallback(() => setTocOpen(false), []);
  const closePrefs = useCallback(() => setPrefsOpen(false), []);
  const closeFootnote = useCallback(() => setFootnote(null), []);

  // Register reader overlays with browser history so Android/browser Back
  // closes them cleanly before leaving the book.
  useHistoryOverlay(tocOpen, closeToc);
  useHistoryOverlay(prefsOpen, closePrefs);
  useHistoryOverlay(footnote !== null, closeFootnote);

  const handleFootnoteJump = useCallback(() => {
    if (!footnote) return;
    const target = footnote;
    setFootnote(null);
    if (target.sameChapter) {
      postToFrame(getCurrentFrame().frame, {
        source: "biocn-host",
        type: "jump",
        anchor: target.targetAnchor,
      });
    } else if (target.targetChapterIndex !== null) {
      navigateToChapter(target.targetChapterIndex, { anchor: target.targetAnchor });
    }
  }, [footnote, getCurrentFrame, navigateToChapter]);

  const handleFootnoteNavigateInternal = useCallback(
    (path: string, anchor: string | null) => {
      if (!book) return;
      setFootnote(null);
      const targetChapter = book.chapters.find((ch) => ch.href === path);
      if (targetChapter) {
        navigateToChapter(targetChapter.index, { anchor });
      }
    },
    [book, navigateToChapter],
  );

  const handleFootnoteOpenExternal = useCallback((href: string) => {
    void openUrl(href).catch(() => {});
  }, []);

  const scheduleProgressSave = useCallback(
    (chapterIndex: number, paragraphIndex: number | null, ratio: number) => {
      lastSavedRef.current = {
        bookId: id,
        chapterIndex,
        paragraphIndex,
        ratio,
        dirty: true,
      };
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        if (lastSavedRef.current) lastSavedRef.current.dirty = false;
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
        case "footnote": {
          if (!isCurrentTarget || !position || !book) break;
          clearPendingFootnoteRequest();
          const resolved = resolveRelativeHref(position.current.href, msg.href);
          const baseHref = resolved?.path ?? position.current.href;
          const targetChapter = resolved
            ? book.chapters.find((ch) => ch.href === resolved.path)
            : position.current;
          const opened = openFootnotePopup({
            label: msg.label,
            html: msg.html,
            baseHref,
            targetChapterIndex: targetChapter ? targetChapter.index : null,
            targetAnchor: msg.anchor,
            sameChapter: msg.sameChapter,
          });
          if (!opened) {
            if (msg.sameChapter) {
              postToFrame(senderFrame, {
                source: "biocn-host",
                type: "jump",
                anchor: msg.anchor,
              });
            } else if (targetChapter) {
              navigateToChapter(targetChapter.index, { anchor: msg.anchor });
            }
          }
          break;
        }
        case "footnote-result": {
          if (!isCurrentTarget) break;
          const pending = footnoteRequestRef.current;
          if (!pending || pending.id !== msg.requestId) break;
          clearPendingFootnoteRequest();
          if (msg.found && msg.html) {
            const opened = openFootnotePopup({
              label: msg.label ?? "注释",
              html: msg.html,
              baseHref: pending.baseHref,
              targetChapterIndex: pending.targetChapterIndex,
              targetAnchor: msg.anchor,
              sameChapter: false,
            });
            if (opened) break;
          }
          pending.fallback();
          break;
        }
        case "link": {
          if (!isCurrentTarget || !position || !book) break;
          const resolved = resolveRelativeHref(position.current.href, msg.href);
          if (!resolved) break;
          const targetChapter = book.chapters.find((ch) => ch.href === resolved.path);
          const fallback = () => {
            if (targetChapter) {
              navigateToChapter(targetChapter.index, { anchor: resolved.anchor });
            }
          };
          if (
            resolved.anchor &&
            !tocAnchors.has(`${resolved.path}#${resolved.anchor}`) &&
            looksLikeFootnoteHref(resolved.path, resolved.anchor) &&
            slotReadyRef.current[senderSlot]
          ) {
            clearPendingFootnoteRequest();
            const requestId = ++footnoteReqSeqRef.current;
            const timer = setTimeout(() => {
              if (footnoteRequestRef.current?.id === requestId) {
                footnoteRequestRef.current = null;
                fallback();
              }
            }, 450);
            footnoteRequestRef.current = {
              id: requestId,
              timer,
              fallback,
              targetChapterIndex: targetChapter ? targetChapter.index : null,
              baseHref: resolved.path,
            };
            postToFrame(senderFrame, {
              source: "biocn-host",
              type: "resolve-footnote",
              requestId,
              href: msg.href,
              anchor: resolved.anchor,
            });
            break;
          }
          fallback();
          break;
        }
        case "external": {
          void openUrl(msg.href).catch(() => {});
          break;
        }
        case "key": {
          if (msg.key === "Escape") {
            if (footnote) {
              setFootnote(null);
              break;
            }
            if (modelsOpen || document.querySelector("dialog[open]")) break;
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
    tocAnchors,
    footnote,
    prefsOpen,
    tocOpen,
    modelsOpen,
    onClose,
    navigateToChapter,
    scheduleProgressSave,
    promoteSlot,
    clearPendingFootnoteRequest,
    openFootnotePopup,
  ]);

  // Host keyboard shortcuts (when focus is outside the iframe).
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (modelsOpen || document.querySelector("dialog[open]")) return;

      const target = event.target as HTMLElement | null;
      const inFormControl =
        Boolean(target?.isContentEditable) ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");

      if (event.key === "Escape") {
        if (prefsOpen) setPrefsOpen(false);
        else if (tocOpen) setTocOpen(false);
        else onClose();
        event.preventDefault();
        return;
      }

      if (inFormControl) return;

      const { frame, ready } = getCurrentFrame();
      if (event.key === "ArrowRight") {
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
    [
      position,
      prefs.viewMode,
      prefsOpen,
      tocOpen,
      modelsOpen,
      onClose,
      navigateToChapter,
      getCurrentFrame,
    ],
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
      navigateToChapter(position.previous.index, {
        edge: prefs.viewMode === "paginated" ? "end" : "start",
      });
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

  const visibleColorState = prefs.coloringEnabled ? colorState : INITIAL_COLOR_STATE;
  const colorPercent =
    visibleColorState.total > 0
      ? Math.min(100, Math.round((visibleColorState.done / visibleColorState.total) * 100))
      : 0;

  // Keep chrome visible while loading or showing an error so the user always
  // has access to back/retry controls.
  const showChrome = chromeVisible || loading || error !== null || tocOpen;
  const mainThemeAttr =
    effectiveTheme === "dark"
      ? "dark"
      : effectiveTheme === "light" || effectiveTheme === "sepia"
        ? "light"
        : undefined;

  return (
    <div className="drawer drawer-end h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom))] overflow-hidden bg-base-100 text-base-content">
      <input
        id="reader-toc-drawer"
        type="checkbox"
        className="drawer-toggle"
        checked={tocOpen}
        onChange={(event) => setTocOpen(event.target.checked)}
      />

      <div className="drawer-content relative flex h-full flex-col overflow-hidden">
        <header
          aria-hidden={!showChrome}
          inert={!showChrome}
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
                {visibleColorState.active && (
                  <span
                    role="status"
                    aria-label="本章着色进度"
                    className="badge badge-soft badge-primary badge-xs shrink-0 gap-1"
                  >
                    <span className="loading loading-spinner loading-xs size-2.5" />
                    着色 {colorPercent}%
                  </span>
                )}
                {visibleColorState.missingModel && (
                  <button
                    type="button"
                    className="badge badge-soft badge-warning badge-xs shrink-0 cursor-pointer hover:badge-warning"
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
              onClick={(event) => {
                // Release pointer/touch focus so Android WebView doesn't keep a
                // sticky highlight on the ghost button after toggling off.
                if (event.detail > 0) event.currentTarget.blur();
                updatePrefs({ coloringEnabled: !prefs.coloringEnabled });
              }}
            >
              着色
            </button>

            <div
              ref={prefsMenuRef}
              className={`dropdown dropdown-end ${prefsOpen ? "dropdown-open" : ""}`}
            >
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
                <ReaderPrefsPopover
                  prefs={prefs}
                  effectiveTheme={effectiveTheme}
                  onUpdate={updatePrefs}
                />
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
          {visibleColorState.active && (
            <progress
              className="progress progress-primary block h-0.5 w-full rounded-none"
              value={visibleColorState.done}
              max={Math.max(visibleColorState.total, 1)}
            />
          )}
        </header>

        {visibleColorState.error && (
          <div className="absolute inset-x-0 top-14 z-10 mx-auto w-full max-w-3xl px-4">
            <div role="alert" className="alert alert-warning alert-soft py-2 text-xs shadow">
              <span className="flex-1 break-words">
                本章着色暂时失败（仍可阅读原文）：{visibleColorState.error}
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
          data-theme={mainThemeAttr}
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
              {SKELETON_LINE_WIDTHS.map((line) => (
                <div
                  key={line.id}
                  className="skeleton h-4 rounded"
                  style={{ width: `${line.width}%` }}
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
                  key={`${slot}:${item.url}`}
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
          inert={!showChrome}
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
                  postToFrame(getCurrentFrame().frame, {
                    source: "biocn-host",
                    type: "seek",
                    ratio,
                  });
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

      <ReaderTocDrawer
        book={book}
        currentIndex={index}
        coloredSet={coloredSet}
        onNavigate={handleTocNavigate}
        onClose={closeToc}
      />

      {footnote && (
        <ReaderFootnoteDialog
          footnote={footnote}
          prefs={effectivePrefs}
          effectiveTheme={effectiveTheme}
          onClose={closeFootnote}
          onJumpToTarget={handleFootnoteJump}
          onNavigateInternal={handleFootnoteNavigateInternal}
          onOpenExternal={handleFootnoteOpenExternal}
        />
      )}
    </div>
  );
}
