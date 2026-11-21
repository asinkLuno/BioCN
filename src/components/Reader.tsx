import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MODEL_MISSING,
  bookChapter,
  bookOpen,
  commandPrefix,
  message,
  type BookView,
  type ChapterView,
} from "../lib/reading";
import {
  BOOK_STYLESHEET,
  paintChapter,
} from "../lib/overlay";
import { createBookView, fetchBookBlob, flattenToc, type TocEntry } from "../lib/foliate";

// `FoliateView` is an ambient global from `src/types/foliate-js.d.ts`.

interface Props {
  id: string;
  /** Called when the reader closes, so the shelf can restore its scroll. */
  onClose: () => void;
  /** Opens settings, for the "download a model" prompt. */
  onOpenSettings: () => void;
  /** Whether settings is on screen above the page. */
  modelsOpen: boolean;
}

/**
 * The reading view: the book's own layout, rendered by foliate-js, with the
 * analyzer's colors painted on top.
 *
 * The Rust side still owns the text: `book_open` hands over the stored EPUB
 * (which foliate lays out through the asset protocol) plus the chapter list,
 * and `book_chapter` delivers one chapter's colored paragraphs when its
 * section loads. Painting is overlay-only — a paragraph that cannot be
 * matched is left uncolored, never mis-colored — so the reader degrades to
 * the book's plain layout while everything else keeps working.
 */
export function Reader({ id, onClose, onOpenSettings, modelsOpen }: Props) {
  const [book, setBook] = useState<BookView | null>(null);
  const [toc, setToc] = useState<TocEntry[] | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  // A section's coloring failing is not a book failure: the layout is already
  // on screen, so the alert rides above it.
  const [chapterError, setChapterError] = useState<string | null>(null);
  const [chapterMissingModel, setChapterMissingModel] = useState(false);
  // Bumped to re-ask for the current section's coloring. Downloading a model
  // in settings is the common reason a chapter failed, and the reader must
  // not sit on that error until the user navigates away and back.
  const [attempt, setAttempt] = useState(0);

  const host = useRef<HTMLDivElement>(null);
  const view = useRef<FoliateView | null>(null);
  // Colored chapters are cached per spine index: flipping back and forth
  // must not re-run the analyzer for text it has already answered.
  const chapters = useRef(new Map<number, ChapterView>());
  // The section on screen, and the document foliate loaded for it — what a
  // retry paints into, and what a late-arriving chapter checks against.
  const section = useRef<{ index: number; doc: Document } | null>(null);
  // A painted document must never be painted again: a second pass would wrap
  // spans in spans. Foliate hands over a fresh document per section load, so
  // this only guards against a retry re-entering on the same one.
  const painted = useRef(new WeakSet<Document>());

  // One parse (and one file fetch) per book: everything else is sections
  // loading as foliate paginates through them.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAt(null);
    setToc(null);
    setChapterError(null);
    setChapterMissingModel(false);
    chapters.current.clear();
    section.current = null;
    bookOpen(id)
      .then(async (opened) => {
        if (cancelled) return;
        setBook(opened);
        // The first chapter with text: a book usually starts with a cover page
        // and a title page, and landing on those looks like a failure.
        const first =
          opened.chapters.find((entry) => entry.paragraphs > 0) ?? opened.chapters[0] ?? null;
        if (!first) {
          setLoading(false);
          setError("这本书没有可阅读的正文。");
          return;
        }
        const blob = await fetchBookBlob(opened.filePath);
        if (cancelled) return;
        const bookView = await createBookView(blob, {
          onLoad: ({ doc, index }) => {
            // `cancelled` is the only guard needed: the effect runs once per
            // `id`, and a switch to another book cancels it before the new
            // one's events can fire.
            if (cancelled) return;
            section.current = { index, doc };
            doc.addEventListener("keydown", onKeyDown);
            loadSection(index, doc);
          },
          onRelocate: (detail) => setAt(detail.index),
        });
        if (cancelled) {
          bookView.close();
          return;
        }
        // fxl (pre-paginated books) has no setStyles — optional call, or the TypeError
        // gets misreported as "this book cannot be opened".
        bookView.renderer.setStyles?.(BOOK_STYLESHEET);
        view.current = bookView;
        host.current?.appendChild(bookView);
        setToc(flattenToc(bookView.book));
        await bookView.goTo(first.index);
        if (cancelled) return;
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setError(message(cause));
      });
    return () => {
      cancelled = true;
      view.current?.close();
      view.current = null;
      if (host.current) host.current.textContent = "";
    };
    // The effect runs once per `id`: everything it closes over (`book`, the
    // handlers) is either set within it or arrives through refs.
  }, [id]);

  /**
   * One section's coloring: cached, or fetched, then painted into its doc.
   *
   * The doc may already have been unloaded by the time the chapter arrives
   * (a fast page-flip), so painting checks against the section on screen.
   */
  const loadSection = (index: number, doc: Document) => {
    // A new section's state is clean: a previous section's failure must not
    // ride above a chapter that has nothing to do with it.
    setChapterError(null);
    setChapterMissingModel(false);
    const cached = chapters.current.get(index);
    if (cached) {
      paintInto(doc, index, cached);
      return;
    }
    bookChapter(id, index)
      .then((chapter) => {
        chapters.current.set(index, chapter);
        paintInto(doc, index, chapter);
      })
      .catch((cause: unknown) => {
        // A missing model is not a failure to show a raw error for: it is
        // something the user can fix, and the prompt says how.
        setChapterError(message(cause));
        setChapterMissingModel(commandPrefix(cause) === MODEL_MISSING);
      });
  };

  const paintInto = (doc: Document, index: number, chapter: ChapterView) => {
    if (section.current?.index !== index || section.current.doc !== doc) return;
    if (painted.current.has(doc)) return;
    painted.current.add(doc);
    const stats = paintChapter(doc, chapter.paragraphs);
    // A drift the look-ahead cannot absorb shows up as skips; say so rather
    // than failing silently, without interrupting the read.
    if (stats.skipped > 0) console.warn(`overlay: ${stats.skipped} 段未匹配，保持无色`);
  };

  // Coming back from settings after a failed section is worth one more try:
  // "download a model" is the reason the prompt sent the user there.
  const wasOpen = useRef(modelsOpen);
  useEffect(() => {
    if (wasOpen.current && !modelsOpen && chapterMissingModel) setAttempt((n) => n + 1);
    wasOpen.current = modelsOpen;
  }, [modelsOpen, chapterMissingModel]);

  useEffect(() => {
    if (attempt === 0) return;
    const current = section.current;
    if (current) loadSection(current.index, current.doc);
    // `loadSection` reads only refs and the primitive `id`.
  }, [attempt]);

  const position = useMemo(() => {
    if (!book || at === null) return null;
    const current = book.chapters.findIndex((entry) => entry.index === at);
    if (current < 0) return null;
    return {
      at: current,
      total: book.chapters.length,
      previous: book.chapters[current - 1] ?? null,
      next: book.chapters[current + 1] ?? null,
    };
  }, [book, at]);

  const goTo = useCallback((index: number) => {
    setTocOpen(false);
    view.current?.goTo(index).catch(() => {});
  }, []);

  // Arrow keys and Escape — attached to the window and, because the book's
  // iframe takes focus once clicked, to every section document as well. The
  // handler reads `position`/`tocOpen` through refs, so one function serves
  // every listener without re-binding.
  const positionRef = useRef(position);
  const tocRef = useRef(tocOpen);
  useEffect(() => {
    positionRef.current = position;
    tocRef.current = tocOpen;
  });

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      // Settings can be open above the page: Escape there dismisses settings,
      // not the book, and an arrow key must not turn the page behind a modal.
      if (document.querySelector("dialog[open]") !== null) return;
      if (event.key === "Escape") {
        if (tocRef.current) setTocOpen(false);
        else onClose();
      } else if (event.key === "ArrowRight") {
        const next = positionRef.current?.next;
        if (next) goTo(next.index);
      } else if (event.key === "ArrowLeft") {
        const previous = positionRef.current?.previous;
        if (previous) goTo(previous.index);
      }
    },
    [onClose, goTo],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  const chapterTitle =
    book && position ? (book.chapters[position.at].title ?? null) : null;

  return (
    <div className="flex min-h-dvh flex-col bg-base-100 text-base-content">
      <header className="sticky top-0 z-10 border-b border-base-content/10 bg-base-100/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-2 py-2 sm:px-4">
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
              {/* `book` lags the switch (the parse is what sets it): naming the
                  old book while opening the new one would be a lie. */}
              {book?.id === id ? book.title : "正在打开…"}
            </p>
            {chapterTitle && (
              <p className="truncate text-xs text-base-content/55">{chapterTitle}</p>
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
      </header>

      {tocOpen && toc !== null && (
        <nav aria-label="章节目录" className="border-b border-base-content/10 bg-base-200/50">
          <ul className="menu mx-auto w-full max-w-3xl max-h-[60vh] flex-nowrap overflow-y-auto px-2 py-2">
            {toc.map((entry) => {
              const summary = book?.chapters.find((c) => c.index === entry.index);
              return (
                <li key={`${entry.index}:${entry.label}`}>
                  <button
                    type="button"
                    className={entry.index === at ? "menu-active" : undefined}
                    style={entry.depth > 0 ? { paddingLeft: `${entry.depth * 1.25}rem` } : undefined}
                    onClick={() => goTo(entry.index)}
                  >
                    <span className="min-w-0 flex-1 truncate text-left">{entry.label}</span>
                    {summary?.paragraphs === 0 && (
                      <span className="badge badge-ghost badge-sm">无正文</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      )}

      {chapterError !== null && (
        <div role="alert" className="alert mx-auto w-full max-w-3xl items-start px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {chapterMissingModel ? "主谓宾着色需要分析模型" : "无法为这一章着色"}
            </p>
            <p className="mt-1 text-sm break-words opacity-80">
              {chapterMissingModel
                ? "在设置中下载一次；之后应用即可离线使用。"
                : chapterError}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
              重试
            </button>
            {chapterMissingModel && (
              <button type="button" className="btn btn-sm btn-primary" onClick={onOpenSettings}>
                打开设置
              </button>
            )}
          </div>
        </div>
      )}

      <main className="relative flex-1 overflow-hidden" aria-busy={loading}>
        {/* The foliate view stays mounted and sized from the first render:
            the paginator measures its host, so it must never be hidden while
            loading. The skeleton and the fatal error are opaque layers above
            it; the coloring alert rides above a readable book. */}
        <div ref={host} className="absolute inset-0" />
        {error !== null ? (
          <div className="absolute inset-0 bg-base-100">
            <div className="mx-auto w-full max-w-3xl px-5 py-10">
              <div role="alert" className="alert alert-error items-start">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">无法打开这本书</p>
                  <p className="mt-1 text-sm break-words opacity-80">{error}</p>
                </div>
                <button type="button" className="btn btn-sm" onClick={onClose}>
                  返回书架
                </button>
              </div>
            </div>
          </div>
        ) : loading ? (
          <div className="absolute inset-0 z-10 bg-base-100">
            <div className="mx-auto w-full max-w-3xl space-y-4 px-5 py-10">
              {Array.from({ length: 8 }, (_, line) => (
                <div
                  key={line}
                  className="skeleton h-4 rounded"
                  // Ragged line lengths, so the placeholder looks like prose.
                  style={{ width: `${[100, 96, 99, 88, 100, 94, 72, 100][line]}%` }}
                />
              ))}
            </div>
          </div>
        ) : null}
      </main>

      <footer className="sticky bottom-0 border-t border-base-content/10 bg-base-100/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-2 py-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!position?.previous}
            onClick={() => position?.previous && goTo(position.previous.index)}
          >
            上一章
          </button>
          <p className="flex-1 text-center text-xs text-base-content/50">
            {position ? `${position.at + 1} / ${position.total}` : ""}
          </p>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!position?.next}
            onClick={() => position?.next && goTo(position.next.index)}
          >
            下一章
          </button>
        </div>
      </footer>
    </div>
  );
}
