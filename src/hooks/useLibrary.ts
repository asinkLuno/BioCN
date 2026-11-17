import { useCallback, useEffect, useRef, useState } from "react";
import {
  libraryCover,
  libraryImport,
  libraryList,
  libraryRemove,
  type Book,
  type ImportError,
} from "../lib/library";
import { message } from "../lib/reading";
import { pickEpubFiles } from "../lib/picker";

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
export type Covers = Record<string, string>;

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

  const exclusive = <T,>(job: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(job, job);
    queue.current = run.catch(() => undefined);
    return run;
  };

  const applySnapshot = (books: Book[]) => {
    const visible = books.filter((book) => !hidden.current.has(book.id));
    setState((s) => ({ ...s, books: visible }));
  };

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
  }, []);

  // Covers load lazily, once per book, and are dropped when a book leaves.
  useEffect(() => {
    const present = new Set(state.books.map((book) => book.id));
    presentIds.current = present;
    setCovers((current) =>
      Object.keys(current).every((id) => present.has(id))
        ? current
        : Object.fromEntries(Object.entries(current).filter(([id]) => present.has(id))),
    );

    const missing = state.books.filter(
      (book) => book.hasCover && !requested.current.has(book.id),
    );
    for (const book of missing) {
      requested.current.add(book.id);
      libraryCover(book.id)
        .then((cover) => {
          // Nothing was stored, or the book left: forget the attempt so a book
          // that comes back is fetched again instead of keeping a placeholder.
          if (!cover || !presentIds.current.has(book.id)) {
            requested.current.delete(book.id);
            return;
          }
          setCovers((current) => ({
            ...current,
            [book.id]: `data:${cover.mime};base64,${cover.base64}`,
          }));
        })
        .catch(() => {
          requested.current.delete(book.id);
        });
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
  }, []);

  const removeBook = useCallback(async (id: string) => {
    // Hidden right away so the tile responds to the tap. The flag also keeps a
    // queued import from flashing the tile back before the removal runs.
    hidden.current.add(id);
    // The shelf as it was, so a failed removal can restore it verbatim.
    const before = booksRef.current;
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
          // The removal failed, so the book is still on disk: show it again even
          // if the re-read failed too.
          applySnapshot(reloaded ?? before);
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
  }, []);

  const dismissErrors = useCallback(() => {
    setState((s) => ({ ...s, errors: [], problem: null }));
  }, []);

  return { ...state, covers, addBooks, removeBook, dismissErrors };
}

