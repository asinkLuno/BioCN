import { useState } from "react";
import { BookTile } from "./components/BookTile";
import { ModelSheet } from "./components/ModelSheet";
import { Reader } from "./components/Reader";
import { useColoring } from "./hooks/useColoring";
import { useLibrary } from "./hooks/useLibrary";
import type { ImportError } from "./lib/library";
import { useRouter } from "./lib/router";

export default function App() {
  const {
    books,
    covers,
    pending,
    loading,
    errors,
    problem,
    addBooks,
    removeBook,
    clearCache,
    dismissErrors,
  } = useLibrary();
  const coloring = useColoring();
  const { route, openBook, closeBook } = useRouter();
  const reading = route.kind === "reader" ? route.bookId : null;
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelRevision, setModelRevision] = useState(0);

  const isEmpty = !loading && books.length === 0 && pending === 0;
  const job = coloring.job;

  // Render one shared `<ModelSheet>` across shelf ⇄ reader transitions so an
  // in-flight model or app-update download is never unmounted by switching views.
  const settingsSheet = (
    <ModelSheet
      open={modelsOpen}
      onClose={() => setModelsOpen(false)}
      onChange={() => setModelRevision((n) => n + 1)}
    />
  );

  // The reader owns the whole window while it is open: a shelf behind a book is
  // a distraction, and the reader's own back button (or system Back) returns here.
  if (reading !== null) {
    return (
      <>
        <Reader
          id={reading}
          onClose={closeBook}
          onOpenSettings={() => setModelsOpen(true)}
          modelsOpen={modelsOpen}
          modelRevision={modelRevision}
        />
        {settingsSheet}
      </>
    );
  }

  return (
    // Match Reader's viewport-locked shell so the shelf header stays pinned at
    // the top on desktop and below Android's status bar, while only `<main>`
    // scrolls (which also clips book-tile menus cleanly below the header).
    <div className="flex h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom))] flex-col overflow-hidden bg-base-100 text-base-content">
      <header className="z-20 shrink-0 border-b border-base-content/10 bg-base-100">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg leading-tight font-semibold tracking-tight">书架</h1>
            <p className="text-xs text-base-content/55">
              {loading ? "正在加载书架…" : books.length === 0 ? "还没有书" : `${books.length} 本书`}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-square btn-ghost btn-sm sm:btn-md"
            aria-label="设置"
            onClick={() => setModelsOpen(true)}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="10" cy="10" r="2.6" />
              <path d="M10 2.6h0a1.4 1.4 0 0 1 1.4 1.4v.7a1 1 0 0 0 .5.9l.6.3a1 1 0 0 0 1 0l.6-.3a1.4 1.4 0 0 1 1.9.5l.5.9a1.4 1.4 0 0 1-.5 1.9l-.6.3a1 1 0 0 0-.5.9v.6a1 1 0 0 0 .5.9l.6.3a1.4 1.4 0 0 1 .5 1.9l-.5.9a1.4 1.4 0 0 1-1.9.5l-.6-.3a1 1 0 0 0-1 0l-.6.3a1 1 0 0 0-.5.9v.7a1.4 1.4 0 0 1-1.4 1.4h-1a1.4 1.4 0 0 1-1.4-1.4v-.7a1 1 0 0 0-.5-.9l-.6-.3a1 1 0 0 0-1 0l-.6.3a1.4 1.4 0 0 1-1.9-.5l-.5-.9a1.4 1.4 0 0 1 .5-1.9l.6-.3a1 1 0 0 0 .5-.9v-.6a1 1 0 0 0-.5-.9l-.6-.3a1.4 1.4 0 0 1-.5-1.9l.5-.9a1.4 1.4 0 0 1 1.9-.5l.6.3a1 1 0 0 0 1 0l.6-.3a1 1 0 0 0 .5-.9v-.7A1.4 1.4 0 0 1 9 2.6z" />
            </svg>
          </button>
        </div>
        {/* A refusal or an interruption is news, so it stays an alert up here.
            The job's progress itself lives on its own book tile, and leaves no
            trace once the job is over. */}
        {coloring.problem !== null && (
          <div className="mx-auto w-full max-w-6xl px-4 pb-2 sm:px-6">
            <div role="alert" className="alert alert-error alert-soft py-2">
              <p className="min-w-0 flex-1 text-sm break-words">{coloring.problem}</p>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={coloring.dismissProblem}
              >
                知道了
              </button>
            </div>
          </div>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-6xl px-4 py-5 pb-24 sm:px-6 sm:py-8 sm:pb-28">
          {(problem !== null || errors.length > 0) && (
            <div
              role="alert"
              className="alert alert-error mb-5 flex-col items-start gap-2 sm:flex-row sm:items-center"
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {problem !== null ? "出了点问题" : errorHeading(errors)}
                </p>
                <ul className="mt-1 list-inside list-disc text-sm opacity-80">
                  {keyedLines(problem !== null ? [problem] : errorDetails(errors)).map(
                    ({ key, text }) => (
                      <li key={key} className="break-words">
                        {text}
                      </li>
                    ),
                  )}
                </ul>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm sm:ml-auto"
                onClick={dismissErrors}
              >
                知道了
              </button>
            </div>
          )}

          {isEmpty ? (
            <EmptyState onAdd={addBooks} />
          ) : (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {books.map((book) => (
                <BookTile
                  key={book.id}
                  book={book}
                  cover={covers[book.id]}
                  progress={job !== null && job.book === book.id ? job : null}
                  anyJob={job !== null}
                  onOpen={openBook}
                  onColorize={coloring.start}
                  onCancel={coloring.cancel}
                  onClearCache={clearCache}
                  onRemove={removeBook}
                />
              ))}
              {Array.from({ length: pending }, (_, slot) => `pending-${slot}`).map((slotKey) => (
                <li key={slotKey} aria-hidden="true">
                  <div className="skeleton aspect-[2/3] w-full rounded-xl" />
                  <div className="skeleton mt-3 h-3.5 w-4/5 rounded" />
                  <div className="skeleton mt-2 h-3 w-2/5 rounded" />
                </li>
              ))}
            </ul>
          )}

          {loading && (
            <p className="sr-only" role="status">
              正在加载书架
            </p>
          )}
        </div>
      </main>

      {/* The floating add button lives over the content, bottom-right, like
          the material FAB: adding is the one action the shelf always offers,
          whatever state it is in. `fixed` positions it against the window; the
          app root fills the window so no container scroll shifts it. */}
      <button
        type="button"
        aria-label="添加书籍"
        onClick={addBooks}
        className="btn btn-primary btn-circle fixed right-5 bottom-[calc(1.25rem+env(safe-area-inset-bottom))] z-20 size-14 text-primary-content shadow-lg transition-transform hover:scale-105 active:scale-95 sm:right-8 sm:bottom-[calc(2rem+env(safe-area-inset-bottom))]"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="size-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <path d="M10 4v12M4 10h12" />
        </svg>
      </button>

      {settingsSheet}
    </div>
  );
}

function errorHeading(errors: ImportError[]) {
  return errors.length === 1 ? `无法添加 ${errors[0].name}` : `${errors.length} 个文件未能添加`;
}

function errorDetails(errors: ImportError[]) {
  return errors.map((error) => `${error.name}: ${error.message}`);
}

function keyedLines(lines: readonly string[]): { key: string; text: string }[] {
  // The same message can occur for two files, so disambiguate duplicates by occurrence.
  const counts = new Map<string, number>();
  return lines.map((text) => {
    const count = counts.get(text) ?? 0;
    counts.set(text, count + 1);
    return { key: count === 0 ? text : `${text}#${count}`, text };
  });
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <section className="mx-auto flex max-w-md flex-col items-center px-2 py-14 text-center sm:py-24">
      <div className="mb-6 flex size-24 items-center justify-center rounded-2xl bg-base-200 text-base-content/45">
        <svg
          aria-hidden="true"
          viewBox="0 0 48 48"
          className="size-11"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 11.5A2.5 2.5 0 0 1 11.5 9H21l3 4h11.5A2.5 2.5 0 0 1 38 15.5v20A2.5 2.5 0 0 1 35.5 38h-24A2.5 2.5 0 0 1 9 35.5z" />
          <path d="M24 21v10M19 26h10" />
        </svg>
      </div>
      <h2 className="text-xl font-semibold tracking-tight">书架还是空的</h2>
      <p className="mt-2 text-sm leading-relaxed text-base-content/65">
        从这台设备添加 EPUB 文件。书籍会被复制到 BioCN 中，因此即使你移动或删除了
        原文件，书架也不会受影响。
      </p>
      <button type="button" className="btn btn-primary mt-6" onClick={onAdd}>
        选择 EPUB 文件
      </button>
    </section>
  );
}
