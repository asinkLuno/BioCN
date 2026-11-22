/**
 * The reading view: one chapter at a time, with the book's own formatting.
 *
 * Architecture (after the foliate-attempt rollback — see
 * docs/rfc/reader-foliate-retrospective.md): foliate-js is used ONLY as an
 * EPUB parser. The Rust analyzer returns each chapter's own XHTML with the
 * 主谓宾 `<span>`s already spliced in at the byte offsets it parsed, and the
 * parser serves that document while rewriting the book's images and CSS to
 * blob:s; the result is rendered into an `<iframe srcdoc>`. One parse of the
 * chapter, one source of truth for where a sentence sits. Scrolling,
 * navigation and keyboard stay in React — the closed-shadow-DOM black box that
 * killed the first attempt is not involved.
 */
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
  fetchBookBlob,
  openColoredBook,
  resolveTocHref,
  sectionForChapter,
  type ColoredBook,
} from "../lib/epub";
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

interface OpenedBook {
  view: BookView;
  book: ColoredBook["book"];
  /** Serves the next chapter's colored document to the parser. */
  put: ColoredBook["put"];
}

type TocItemData = NonNullable<OpenedBook["book"]["toc"]>[number];

function TocItem({ item, book, chapters, currentIndex, onNavigate }: {
  item: TocItemData;
  book: OpenedBook["book"];
  chapters: BookView["chapters"];
  currentIndex: number | null;
  onNavigate: (destination: NonNullable<ReturnType<typeof resolveTocHref>>) => void;
}) {
  const destination = item.href ? resolveTocHref(book, item.href, chapters) : null;
  const label = item.label || "未命名章节";
  return (
    <li>
      {destination ? (
        <button type="button" className={destination.index === currentIndex && !destination.anchor ? "menu-active" : undefined}
          onClick={() => onNavigate(destination)}>{label}</button>
      ) : <span className="menu-title">{label}</span>}
      {item.subitems?.length ? <ul>{item.subitems.map((child, i) => (
        <TocItem key={i} item={child} book={book} chapters={chapters} currentIndex={currentIndex} onNavigate={onNavigate} />
      ))}</ul> : null}
    </li>
  );
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
function Frame({ srcdoc, title, jump, onKeyDown }: {
  srcdoc: string;
  title: string;
  jump: { anchor: string | null } | null;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let detach: (() => void) | undefined;
    const attach = () => {
      detach?.();
      const doc = frame.contentDocument;
      if (!doc?.body) return;
      const measure = () => setHeight(Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, 200));
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
      observer?.observe(doc.body);
      doc.addEventListener("keydown", onKeyDown);
      measure();
      let tick = 0;
      if (jump) tick = requestAnimationFrame(() => {
        tick = requestAnimationFrame(() => {
          const main = frame.parentElement;
          if (!main || frame.contentDocument !== doc) return;
          const target = jump.anchor && (doc.getElementById(jump.anchor) ?? doc.getElementsByName(jump.anchor)[0]);
          main.scrollTop = target ? main.scrollTop + frame.getBoundingClientRect().top - main.getBoundingClientRect().top + target.getBoundingClientRect().top : 0;
        });
      });
      detach = () => {
        cancelAnimationFrame(tick);
        observer?.disconnect();
        doc.removeEventListener("keydown", onKeyDown);
      };
    };
    frame.addEventListener("load", attach);
    if (frame.contentDocument?.readyState === "complete") attach();
    return () => {
      frame.removeEventListener("load", attach);
      detach?.();
    };
  }, [onKeyDown, jump]);
  return (
    <iframe
      // srcdoc content cannot reach tauri: IPC, but it also cannot navigate
      // away; the sandbox is for scripts the book ships.
      sandbox="allow-same-origin"
      title={title}
      className="block w-full border-0 bg-transparent"
      style={{ height: height ?? "50vh" }}
      srcDoc={srcdoc}
      ref={frameRef}
    />
  );
}

export function Reader({ id, onClose, onOpenSettings, modelsOpen }: Props) {
  const [opened, setOpened] = useState<OpenedBook | null>(null);
  const [chapter, setChapter] = useState<ChapterView | null>(null);
  const [index, setIndex] = useState<number | null>(null);
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const [jump, setJump] = useState<NonNullable<ReturnType<typeof resolveTocHref>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missingModel, setMissingModel] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  // Bumped to re-ask for the chapter. Downloading a model in settings is the
  // common reason a chapter failed, and the reader must not sit on that error
  // until the user navigates away and back.
  const [attempt, setAttempt] = useState(0);
  const [openAttempt, setOpenAttempt] = useState(0);
  const wasOpen = useRef(modelsOpen);
  const content = useRef<HTMLDivElement>(null);

  // Opening a book: TOC (with chapter paragraphs) via IPC, EPUB file via the
  // asset protocol into the parser. Either may fail; both are fatal for now.
  useEffect(() => {
    let cancelled = false;
    let parsed: ColoredBook | undefined;
    setOpened(null);
    setError(null);
    setMissingModel(false);
    setLoading(true);
    setChapter(null);
    setJump(null);
    setIndex(null);
    setSrcdoc(null);
    bookOpen(id)
      .then(async (view) => {
        if (cancelled) return null;
        if (!view.filePath) throw new Error("book-missing: 书库缺少这本书的文件");
        const file = await fetchBookBlob(view.filePath);
        if (cancelled) return null;
        parsed = await openColoredBook(file);
        if (cancelled) {
          parsed.book.destroy();
          return null;
        }
        return { view, book: parsed.book, put: parsed.put };
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
      parsed?.book.destroy();
    };
  }, [id, openAttempt]);

  useEffect(() => {
    // `index === null` is the gap between opening a book and knowing its first
    // chapter. Requiring the loaded book to be this book is what keeps a
    // switch from asking for the previous book's chapter number: `index` is
    // cleared above, but the render that still carries the old value must not
    // fire a request either.
    if (index === null || opened?.view.id !== id) return;
    let cancelled = false;
    let acquired: OpenedBook["book"]["sections"][number] | undefined;
    setLoading(true);
    setError(null);
    bookChapter(id, index)
      .then(async (loaded) => {
        if (cancelled) return;
        const section = sectionForChapter(opened.book, loaded.manifestId);
        if (!section) throw new Error("book-chapter: 这一章不在书文件里");
        // The chapter's colored document is what the loader must read, or the
        // srcdoc would come out uncolored: `load()` serializes whatever the
        // wrapped `loadText` hands it and rewrites the book's resources to
        // blob: on the way. `createDocument()` skips that rewriting, leaving
        // the book's relative URLs broken.
        opened.put(section.id, loaded.html);
        const url = await section.load();
        if (cancelled) {
          section.unload();
          return;
        }
        acquired = section;
        if (typeof url !== "string") {
          throw new Error("book-chapter: 这一章不是文档");
        }
        const response = await fetch(url);
        if (!response.ok) throw new Error(`book-chapter: 无法读取章节（${response.status}）`);
        const str = await response.text();
        if (cancelled) return;
        const doc = new DOMParser().parseFromString(str, "text/html");
        if (!doc.documentElement) throw new Error("book-chapter: 这一章解析失败");
        setSrcdoc(renderSection(doc));
        setChapter(loaded);
        setLoading(false);
        // A chapter that arrived means whatever failed before no longer does;
        // leaving the flag set would make the next trip to settings refetch a
        // chapter for no reason.
        setMissingModel(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        acquired?.unload();
        acquired = undefined;
        setLoading(false);
        // A missing model is not a failure to show a raw error for: it is
        // something the user can fix, and the prompt says how.
        setMissingModel(commandPrefix(cause) === MODEL_MISSING);
        setError(message(cause));
      });
    return () => {
      cancelled = true;
      acquired?.unload();
    };
  }, [id, index, opened, attempt]);

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

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")) return;
    if (document.querySelector("dialog[open]")) return;
    if (event.key === "Escape") {
      if (tocOpen) setTocOpen(false);
      else onClose();
    } else if (event.key === "ArrowRight" && position?.next) {
      setJump(null);
      setIndex(position.next.index);
    } else if (event.key === "ArrowLeft" && position?.previous) {
      setJump(null);
      setIndex(position.previous.index);
    } else return;
    event.preventDefault();
  }, [position, tocOpen, onClose]);

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  return (
    <div className="flex h-dvh flex-col bg-base-100 text-base-content">
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
          className="w-full max-h-[60vh] overflow-y-auto overscroll-contain border-b border-base-content/10 bg-base-200/50"
        >
          <ul className="menu mx-auto w-full max-w-3xl flex-nowrap px-2 py-2">
            {opened.book.toc?.length ? opened.book.toc.map((entry, item) => (
              <TocItem
                key={`${entry.href ?? entry.label ?? "toc"}-${item}`}
                item={entry}
                book={opened.book}
                chapters={opened.view.chapters}
                currentIndex={index}
                onNavigate={(destination) => {
                  setJump(destination);
                  setIndex(destination.index);
                  setTocOpen(false);
                }}
              />
            )) : opened.view.chapters.map((entry) => (
              <li key={entry.index}>
                <button
                  type="button"
                  className={entry.index === index ? "menu-active" : undefined}
                  disabled={entry.paragraphs === 0}
                  onClick={() => {
                    setJump({ index: entry.index, anchor: null });
                    setIndex(entry.index);
                    setTocOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-left">{entry.title ?? `第 ${entry.index} 节`}</span>
                  {entry.paragraphs === 0 && <span className="badge badge-ghost badge-sm">无正文</span>}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <main
        ref={content}
        className="w-full flex-1 overflow-y-auto overscroll-contain"
        aria-busy={loading}
      >
        {error !== null ? (
          <div role="alert" className="alert alert-error mx-auto mt-4 max-w-3xl items-start">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {missingModel ? "主谓宾着色需要分析模型" : index === null ? "无法打开这本书" : "无法打开这一章"}
              </p>
              <p className="mt-1 text-sm break-words opacity-80">
                {missingModel
                  ? "在设置中下载一次；之后应用即可离线使用。"
                  : error}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button type="button" className="btn btn-sm" onClick={() => (index === null ? setOpenAttempt : setAttempt)((n) => n + 1)}>
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
          // Same measure as the page body (48rem including its padding), so
          // the placeholder does not jump wide-to-narrow when text arrives.
          <div className="mx-auto max-w-3xl space-y-4 px-6 pt-5 pb-4">
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
          <Frame jump={chapter?.index === jump?.index ? jump : null} onKeyDown={onKeyDown} srcdoc={srcdoc} title={chapter?.title ?? "章节内容"} />
        )}
      </main>

      <footer className="sticky bottom-0 border-t border-base-content/10 bg-base-100/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-2 py-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!position?.previous}
            onClick={() => { setJump(null); if (position?.previous) setIndex(position.previous.index); }}
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
            onClick={() => { setJump(null); if (position?.next) setIndex(position.next.index); }}
          >
            下一章
          </button>
        </div>
      </footer>
    </div>
  );
}

