/**
 * The reading view: one chapter at a time, with the book's own formatting.
 *
 * Architecture (after the foliate-attempt rollback — see
 * docs/rfc/reader-foliate-retrospective.md): foliate-js is used ONLY as an
 * EPUB parser. Each chapter's document (with the book's images and CSS, whose
 * URLs the parser rewrites to blob:s) is colored in place by the overlay and
 * rendered into an `<iframe srcdoc>`. Scrolling, navigation and keyboard stay
 * in React — the closed-shadow-DOM black box that killed the first attempt is
 * not involved.
 *
 * Coloring spans arrive from the Rust analyzer with UTF-16 offsets and are
 * verified against the document text before painting; a paragraph that cannot
 * be matched stays uncolored rather than mis-colored.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MODEL_MISSING,
  bookChapter,
  bookOpen,
  commandPrefix,
  message,
  type BookView,
  type ChapterView,
} from "../lib/reading";
import { fetchBookBlob, openBook } from "../lib/epub";
import { renderSection } from "../lib/section";

interface Props {
  id: string;
  /** Called when the reader closes, so the shelf can restore its scroll. */
  onClose: () => void;
  /** Opens settings, for the "download a model" prompt. */
  onOpenSettings: () => void;
  /** Whether settings is on screen above the page. */
  modelsOpen: boolean;
}

/** One open book: the parsed TOC plus the parser instance behind it. */
interface OpenedBook {
  view: BookView;
  book: Awaited<ReturnType<typeof openBook>>;
}

/**
 * The chapter viewport: an srcdoc iframe holding the book's own document.
 *
 * An iframe has no intrinsic height, and an srcdoc document does not size
 * `h-fit` — without measuring, a long chapter gets an inner scrollbar and the
 * page looks cut off. So the frame reports its content height on load and
 * keeps watching the document (images decode late, book CSS reflows late),
 * and `main` above stays the only scroller — no pagination engine in between.
 */
function Frame({ srcdoc, title }: { srcdoc: string; title: string }) {
  const [height, setHeight] = useState<number | null>(null);
  // Exactly one ResizeObserver stays alive per frame; a chapter swap replaces
  // the document, so the previous one is disconnected when the new arrives.
  const observerRef = useRef<ResizeObserver | null>(null);

  return (
    <iframe
      // srcdoc content cannot reach tauri: IPC, but it also cannot navigate
      // away; the sandbox is for scripts the book ships.
      sandbox="allow-same-origin"
      title={title}
      className="w-full border-0 bg-transparent"
      style={{ height: height ?? "50vh" }}
      srcDoc={srcdoc}
      onLoad={(event) => {
        const frame = event.currentTarget;
        const doc = frame.contentDocument;
        if (!doc?.body) return;
        const read = () =>
          setHeight(
            Math.max(
              doc.body.scrollHeight,
              doc.documentElement.scrollHeight,
              200,
            ),
          );
        read();
        // Images decode late; book CSS can reflow late too.
        doc.fonts?.ready.then(read);
        const observer = new ResizeObserver(read);
        observer.observe(doc.body);
        // A chapter swap replaces the document; disconnect the previous
        // observer so exactly one is watching the live one.
        observerRef.current?.disconnect();
        observerRef.current = observer;
      }}
    />
  );
}

export function Reader({ id, onClose, onOpenSettings, modelsOpen }: Props) {
  const [opened, setOpened] = useState<OpenedBook | null>(null);
  const [chapter, setChapter] = useState<ChapterView | null>(null);
  const [index, setIndex] = useState<number | null>(null);
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missingModel, setMissingModel] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  // Bumped to re-ask for the chapter. Downloading a model in settings is the
  // common reason a chapter failed, and the reader must not sit on that error
  // until the user navigates away and back.
  const [attempt, setAttempt] = useState(0);
  const wasOpen = useRef(modelsOpen);
  const content = useRef<HTMLDivElement>(null);

  // Opening a book: TOC (with chapter paragraphs) via IPC, EPUB file via the
  // asset protocol into the parser. Either may fail; both are fatal for now.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setChapter(null);
    setIndex(null);
    setSrcdoc(null);
    bookOpen(id)
      .then(async (view) => {
        if (cancelled) return null;
        if (!view.filePath) throw new Error("book-missing: 书库缺少这本书的文件");
        const file = await fetchBookBlob(view.filePath);
        const book = await openBook(file);
        return { view, book };
      })
      .then((value) => {
        if (cancelled || !value) return;
        setOpened(value);
        // The first chapter with text: a book usually starts with a cover page
        // and a title page, and landing on those looks like a failure.
        const first =
          value.view.chapters.find((entry) => entry.paragraphs > 0) ??
          value.view.chapters[0] ??
          null;
        setIndex(first ? first.index : null);
        if (first === null || first === undefined) {
          setLoading(false);
          setError("这本书没有可阅读的正文。");
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setError(message(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    // `index === null` is the gap between opening a book and knowing its first
    // chapter. Requiring the loaded book to be this book is what keeps a
    // switch from asking for the previous book's chapter number: `index` is
    // cleared above, but the render that still carries the old value must not
    // fire a request either.
    if (index === null || opened?.view.id !== id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    bookChapter(id, index)
      .then(async (loaded) => {
        if (cancelled) return;
        // Parser sections and Rust chapters share the spine index (rbook
        // keeps dangling spine items, foliate filters them — a warning here
        // beats silently coloring the wrong chapter on a broken book).
        const section = opened.book.sections[index];
        if (!section) throw new Error("book-chapter: 这一章不在书文件里");
        const doc = await section.load();
        if (cancelled) {
          section.unload();
          return;
        }
        if (!(doc instanceof Document)) throw new Error("book-chapter: 这一章不是文档");
        setSrcdoc(renderSection(doc, loaded.paragraphs));
        setChapter(loaded);
        setLoading(false);
        // A chapter that arrived means whatever failed before no longer does;
        // leaving the flag set would make the next trip to settings refetch a
        // chapter for no reason.
        setMissingModel(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoading(false);
        // A missing model is not a failure to show a raw error for: it is
        // something the user can fix, and the prompt says how.
        setMissingModel(commandPrefix(cause) === MODEL_MISSING);
        setError(message(cause));
      });
    return () => {
      cancelled = true;
    };
    // `opened` enters as the primitive `opened?.view.id`: the guard below is
    // the only use, and a dependency on the object would re-run this effect on
    // every parse that lands, for a fetch the previous run already decided
    // against (rerender-dependencies).
  }, [id, index, opened?.view.id, opened?.book, attempt]);

  // Coming back from settings after a failed chapter is worth one more try:
  // "download a model" is the reason the prompt sent the user there.
  useEffect(() => {
    if (wasOpen.current && !modelsOpen && missingModel) setAttempt((n) => n + 1);
    wasOpen.current = modelsOpen;
  }, [modelsOpen, missingModel]);

  // A new chapter starts at the top, the way turning a page does. `scrollTop`
  // rather than `scrollTo`: the assignment is a no-op where smooth scrolling is
  // unavailable (old webviews, jsdom) instead of a crash.
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [chapter]);

  const position = useMemo(() => {
    if (!opened || index === null) return null;
    const at = opened.view.chapters.findIndex((entry) => entry.index === index);
    if (at < 0) return null;
    return {
      at,
      total: opened.view.chapters.length,
      previous: opened.view.chapters[at - 1],
      next: opened.view.chapters[at + 1],
    };
  }, [opened, index]);

  // Arrow keys and Escape, but never while the user is typing or has a menu open.

  // The handler reads `position`/`tocOpen` through refs, so the listener is
  // attached once for the page's lifetime instead of on every chapter flip or
  // contents-panel toggle (rerender-dependencies / advanced-use-latest).
  const positionRef = useRef(position);
  const tocRef = useRef(tocOpen);
  useEffect(() => {
    positionRef.current = position;
    tocRef.current = tocOpen;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
        if (next) setIndex(next.index);
      } else if (event.key === "ArrowLeft") {
        const previous = positionRef.current?.previous;
        if (previous) setIndex(previous.index);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
              {/* `opened` lags the switch (the parse is what sets it): naming the
                  old book while opening the new one would be a lie. */}
              {opened?.view.id === id ? opened.view.title : "正在打开…"}
            </p>
            {chapter?.title && (
              <p className="truncate text-xs text-base-content/55">{chapter.title}</p>
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

      {tocOpen && opened && (
        <nav
          aria-label="章节目录"
          className="border-b border-base-content/10 bg-base-200/50"
        >
          <ul className="menu mx-auto w-full max-w-3xl max-h-[60vh] flex-nowrap overflow-y-auto px-2 py-2">
            {opened.view.chapters.map((entry) => (
              <li key={entry.index}>
                <button
                  type="button"
                  className={entry.index === index ? "menu-active" : undefined}
                  // A spine document with no prose (a cover, a copyright page) is
                  // still listed: hiding it would renumber the chapter list away
                  // from the book's own numbering.
                  disabled={entry.paragraphs === 0}
                  onClick={() => {
                    setIndex(entry.index);
                    setTocOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-left">
                    {entry.title ?? `第 ${entry.index} 节`}
                  </span>
                  {entry.paragraphs === 0 && (
                    <span className="badge badge-ghost badge-sm">无正文</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <main
        ref={content}
        className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-5 py-6 sm:px-8 sm:py-10"
        aria-busy={loading}
      >
        {error !== null ? (
          <div role="alert" className="alert alert-error items-start">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {missingModel ? "主谓宾着色需要分析模型" : "无法打开这一章"}
              </p>
              <p className="mt-1 text-sm break-words opacity-80">
                {missingModel
                  ? "在设置中下载一次；之后应用即可离线使用。"
                  : error}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
                重试
              </button>
              {missingModel && (
                <button type="button" className="btn btn-sm btn-primary" onClick={onOpenSettings}>
                  打开设置
                </button>
              )}
            </div>
          </div>
        ) : loading || srcdoc === null ? (
          <div className="space-y-4">
            {Array.from({ length: 8 }, (_, line) => (
              <div
                key={line}
                className="skeleton h-4 rounded"
                // Ragged line lengths, so the placeholder looks like prose.
                style={{ width: `${[100, 96, 99, 88, 100, 94, 72, 100][line]}%` }}
              />
            ))}
          </div>
        ) : (
          <Frame srcdoc={srcdoc} title={chapter?.title ?? "章节内容"} />
        )}
      </main>

      <footer className="sticky bottom-0 border-t border-base-content/10 bg-base-100/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-2 py-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!position?.previous}
            onClick={() => position?.previous && setIndex(position.previous.index)}
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
            onClick={() => position?.next && setIndex(position.next.index)}
          >
            下一章
          </button>
        </div>
      </footer>
    </div>
  );
}

