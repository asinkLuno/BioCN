import { useState } from "react";
import { useLibrary } from "./hooks/useLibrary";
import { BookTile } from "./components/BookTile";
import { Reader } from "./components/Reader";
import { ModelSheet } from "./components/ModelSheet";
import type { ImportError } from "./lib/library";

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
    dismissErrors,
  } = useLibrary();
  const [reading, setReading] = useState<string | null>(null);
  const [modelsOpen, setModelsOpen] = useState(false);

  const isEmpty = !loading && books.length === 0 && pending === 0;

  // The reader owns the whole window while it is open: a shelf behind a book is
  // a distraction, and the reader's own back button returns here.
  if (reading !== null) {
    return (
      <>
        <Reader
          id={reading}
          onClose={() => setReading(null)}
          onOpenSettings={() => setModelsOpen(true)}
          modelsOpen={modelsOpen}
        />
        <ModelSheet
          open={modelsOpen}
          onClose={() => setModelsOpen(false)}
        />
      </>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-base-100 text-base-content">
      <header className="sticky top-0 z-10 border-b border-base-content/10 bg-base-100/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg leading-tight font-semibold tracking-tight">Library</h1>
            <p className="text-xs text-base-content/55">
              {loading
                ? "Loading your books…"
                : books.length === 0
                  ? "No books yet"
                  : `${books.length} ${books.length === 1 ? "book" : "books"}`}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-square btn-ghost btn-sm sm:btn-md"
            aria-label="Settings"
            onClick={() => setModelsOpen(true)}
          >            <svg
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
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:px-6 sm:py-8">
        {(problem !== null || errors.length > 0) && (
          <div role="alert" className="alert alert-error mb-5 flex-col items-start gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0">
              <p className="font-medium">
                {problem !== null ? "Something went wrong" : errorHeading(errors)}
              </p>
              <ul className="mt-1 list-inside list-disc text-sm opacity-80">
                {(problem !== null ? [problem] : errorDetails(errors)).map((line, index) => (
                  // The same message can occur for two files, so index the key.
                  <li key={`${index}:${line}`} className="break-words">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm sm:ml-auto"
              onClick={dismissErrors}
            >
              Dismiss
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
                id={book.id}
                book={book}
                cover={covers[book.id]}
                onOpen={setReading}
                onRemove={removeBook}
              />
            ))}
            {Array.from({ length: pending }, (_, index) => (
              <li key={`pending-${index}`} aria-hidden="true">
                <div className="skeleton aspect-[2/3] w-full rounded-xl" />
                <div className="skeleton mt-3 h-3.5 w-4/5 rounded" />
                <div className="skeleton mt-2 h-3 w-2/5 rounded" />
              </li>
            ))}
          </ul>
        )}

        {loading && (
          <p className="sr-only" role="status">
            Loading library
          </p>
        )}
      </main>

      {/* The floating add button lives over the content, bottom-right, like
          the material FAB: adding is the one action the shelf always offers,
          whatever state it is in. `fixed` positions it against the window; the
          app root fills the window so no container scroll shifts it. */}
      <button
        type="button"
        aria-label="Add books"
        onClick={addBooks}
        className="btn btn-primary btn-circle fixed bottom-5 right-5 z-20 size-14 text-primary-content shadow-lg transition-transform hover:scale-105 active:scale-95 sm:bottom-8 sm:right-8"
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

      <ModelSheet
        open={modelsOpen}
        onClose={() => setModelsOpen(false)}
      />
    </div>
  );
}

function errorHeading(errors: ImportError[]) {
  return errors.length === 1
    ? `Couldn’t add ${errors[0].name}`
    : `${errors.length} files couldn’t be added`;
}

function errorDetails(errors: ImportError[]) {
  return errors.map((error) => `${error.name}: ${error.message}`);
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
      <h2 className="text-xl font-semibold tracking-tight">Your shelf is empty</h2>
      <p className="mt-2 text-sm leading-relaxed text-base-content/65">
        Add EPUB files from this device. Books are copied into BioCN, so your shelf
        stays intact even if you move or delete the originals.
      </p>
      <button type="button" className="btn btn-primary mt-6" onClick={onAdd}>
        Choose EPUB files
      </button>
    </section>
  );
}
