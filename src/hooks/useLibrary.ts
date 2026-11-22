import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Book,
  type ImportError,
  libraryCover,
  libraryImport,
  libraryList,
  libraryRemove,
} from "../lib/library";
import { pickEpubFiles } from "../lib/picker";
import { clearBookCache, message } from "../lib/reading";

interface State {
  books: Book[];
  /** Number of files being imported, shown as skeleton tiles. */
  pending: number;
  loading: boolean;
  /** Per-file import failures. */
  errors: ImportError[];
  /** A whole-operation failure, e.g. the picker or a command throwing. */
  problem: string | null;
}

/** Cover data URLs keyed by book id. */
type Covers = Record<string, string>;

export function useLibrary() {
  const [state, setState] = useState<State>({
    books: [],
    pending: 0,
    loading: true,
    errors: [],
    problem: null,
  });
  const [covers, setCovers] = useState<Covers>({});
  const presentIds = useRef(new Set<string>());
  const requested = useRef(new Set<string>());
  // Every mutation runs after the previous one finished, so each command's
  // shelf snapshot is the newest one and cannot be overwritten by a slower,
  // older call. Without this the shelf needed ordering guards on every path.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** Books hidden optimistically while their removal is queued. */
  const hidden = useRef(new Set<string>());
  // The shelf, always current: a callback with stable identity (useCallback
  // with []) must read the latest books through a ref, never through the
  // stale `state` captured when it was first created.
  const booksRef = useRef<Book[]>([]);
  booksRef.current = state.books;

  const exclusive = useCallback(<T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(job, job);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  const applySnapshot = useCallback((books: Book[]) => {
    const visible = books.filter((book) => !hidden.current.has(book.id));
    setState((s) => ({ ...s, books: visible }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Queued like every mutation: a slow first read must not land on top of a
    // snapshot an import already applied.
    void exclusive(async () => {
      const books = await libraryList().catch((error: unknown) => ({ error }));
      if (cancelled) return;
      if ("error" in books) {
        setState((s) => ({ ...s, loading: false, problem: message(books.error) }));
        return;
      }
      applySnapshot(books);
      setState((s) => ({ ...s, loading: false }));
    });
    return () => {
      cancelled = true;
    };
  }, [applySnapshot, exclusive]);

  // Covers load lazily, once per book, and are dropped when a book leaves.
  useEffect(() => {
    const present = new Set(state.books.map((book) => book.id));
    presentIds.current = present;
    setCovers((current) =>
      Object.keys(current).every((id) => present.has(id))
        ? current
        : Object.fromEntries(Object.entries(current).filter(([id]) => present.has(id))),
    );

    const missing = state.books.filter((book) => book.hasCover && !requested.current.has(book.id));
    if (missing.length === 0) return;

    for (const book of missing) {
      requested.current.add(book.id);
    }
    // Bound concurrent cover IPC fetches (max 4 in flight) and flush in small
    // batches so opening a large shelf does not fire N concurrent IPC reads and
    // N full-shelf re-renders at once.
    const CONCURRENCY = 4;
    let cursor = 0;
    const worker = async () => {
      while (cursor < missing.length) {
        const book = missing[cursor++];
        if (!presentIds.current.has(book.id)) {
          requested.current.delete(book.id);
          continue;
        }
        try {
          const cover = await libraryCover(book.id);
          if (!cover || !presentIds.current.has(book.id)) {
            requested.current.delete(book.id);
            continue;
          }
          setCovers((current) => ({
            ...current,
            [book.id]: `data:${cover.mime};base64,${cover.base64}`,
          }));
        } catch {
          requested.current.delete(book.id);
        }
      }
    };
    const workers = Math.min(CONCURRENCY, missing.length);
    for (let i = 0; i < workers; i++) {
      void worker();
    }
  }, [state.books]);

  const addBooks = useCallback(async () => {
    let paths: string[];
    try {
      paths = await pickEpubFiles();
    } catch (error) {
      setState((s) => ({ ...s, problem: message(error) }));
      return;
    }
    if (paths.length === 0) return;

    setState((s) => ({ ...s, pending: s.pending + paths.length }));
    await exclusive(async () => {
      try {
        const report = await libraryImport(paths);
        applySnapshot(report.library);
        setState((s) => ({ ...s, errors: [...s.errors, ...report.errors] }));
      } catch (error) {
        setState((s) => ({ ...s, problem: message(error) }));
      } finally {
        setState((s) => ({ ...s, pending: Math.max(0, s.pending - paths.length) }));
      }
    });
  }, [applySnapshot, exclusive]);

  const removeBook = useCallback(
    async (id: string) => {
      // Hidden right away so the tile responds to the tap. The flag also keeps a
      // queued import from flashing the tile back before the removal runs.
      hidden.current.add(id);
      const removedBook = booksRef.current.find((book) => book.id === id) ?? null;
      setState((s) => ({ ...s, books: s.books.filter((book) => book.id !== id) }));
      await exclusive(async () => {
        try {
          const result = await libraryRemove(id).then(
            (books) => ({ books }),
            (error: unknown) => ({ error }),
          );
          // The removal has been decided, so the shelf owns the answer again.
          hidden.current.delete(id);

          if ("error" in result) {
            const reloaded = await libraryList().catch(() => null);
            setState((s) => ({ ...s, problem: message(result.error) }));
            // The removal failed, so the book is still on disk: show it again
            // without wiping out any books imported while removal was queued.
            if (reloaded !== null) {
              applySnapshot(reloaded);
            } else if (removedBook !== null) {
              setState((s) =>
                s.books.some((b) => b.id === removedBook.id)
                  ? s
                  : { ...s, books: [removedBook, ...s.books] },
              );
            }
            return;
          }

          applySnapshot(result.books);
          setCovers((current) => {
            const next = { ...current };
            delete next[id];
            return next;
          });
          requested.current.delete(id);
        } finally {
          // A failed job must never leave the book hidden from later snapshots.
          hidden.current.delete(id);
        }
      });
    },
    [applySnapshot, exclusive],
  );

  const dismissErrors = useCallback(() => {
    setState((s) => ({ ...s, errors: [], problem: null }));
  }, []);

  /**
   * Clears a book's coloring cache. Nothing on the shelf changes — the cache
   * is invisible — so a success stays silent and only a refusal is news here.
   */
  const clearCache = useCallback(async (id: string) => {
    try {
      await clearBookCache(id);
    } catch (error) {
      setState((s) => ({ ...s, problem: message(error) }));
    }
  }, []);

  return { ...state, covers, addBooks, removeBook, clearCache, dismissErrors };
}
