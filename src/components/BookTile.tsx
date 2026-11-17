import { memo, useEffect, useRef, useState } from "react";
import type { Book } from "../lib/library";
import { ExportDialog } from "./ExportDialog";

interface Props {
  id: string;
  book: Book;
  cover?: string;
  /** This book is the one being colored right now: opening it is refused. */
  coloring: boolean;
  /** Any job at all is running, so a second 着色全书 would be refused. */
  anyJob: boolean;
  onOpen: (id: string) => void;
  onColorize: (id: string) => void;
  onRemove: (id: string) => void;
}

/** Wrapping in a memo is what keeps a shelf worth of tiles from re-rendering
    when one tile's cover loads or its menu opens. */
export const BookTile = memo(function BookTile({
  book,
  cover,
  coloring,
  anyJob,
  onOpen,
  onColorize,
  onRemove,
}: Props) {
  const [coverBroken, setCoverBroken] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [exporting, setExporting] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const closeMenu = () => {
    setMenuOpen(false);
    // Closing must not drop focus to <body>: put it back on the trigger.
    trigger.current?.focus();
  };

  // The menu is only rendered while open, so it must close like a real popover.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeMenu();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // The menu only exists while open, so its first item takes focus itself.
    firstItem.current?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  // A real modal, not just a dialog with the `open` attribute: the page behind
  // it is inert and focus is trapped until the user decides.
  useEffect(() => {
    const element = dialog.current;
    if (element && confirming && !element.open) element.showModal();
  }, [confirming]);

  /** Arrow keys walk the menu, as a `role="menu"` is expected to. */
  const moveMenuFocus = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = (index + step + items.length) % items.length;
    items[next]?.focus();
  };

  /** Dismisses the confirmation. The trigger is unmounted after a removal, so refocus first. */
  const dismissConfirm = () => {
    dialog.current?.close();
    setConfirming(false);
    trigger.current?.focus();
  };

  const showCover = cover !== undefined && !coverBroken;

  return (
    <li>
      <article className="flex h-full flex-col gap-3">
        <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-base-200 ring-1 ring-base-content/10 transition ring-offset-2 ring-offset-base-100 hover:ring-primary/40 focus-within:ring-primary/60">
          {/* The cover is the button: on a shelf, the book itself is the target.
              It sits under the menu, which needs its own taps. */}
          <button
            type="button"
            aria-label={`阅读《${book.title}》`}
            // A book being colored cannot be opened: the job owns it, and the
            // reader would analyze the same chapter a second time.
            disabled={coloring}
            title={coloring ? "着色全书中，完成后才能打开" : undefined}
            className="group block h-full w-full cursor-pointer focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => onOpen(book.id)}
          >
            {showCover ? (
              <img
                src={cover}
                alt=""
                loading="lazy"
                onError={() => setCoverBroken(true)}
                className="h-full w-full object-cover transition group-hover:brightness-95"
              />
            ) : (
              // A `span`, not a `div`: a button may only contain phrasing
              // content, and the fallback icon is inside one.
              <span className="flex h-full items-center justify-center p-4 text-base-content/35">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 48 48"
                  className="size-10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M24 11v27M24 11c-5-2.6-10-2.6-14 0v24c4-2.6 9-2.6 14 0 5-2.6 10-2.6 14 0V11c-4-2.6-9-2.6-14 0Z" />
                </svg>
              </span>
            )}
          </button>

          <div ref={menuRoot} className="dropdown dropdown-end absolute top-2 right-2">
            {coloring && (
              // The label, not just the muted cover: a disabled book with no
              // reason reads as broken.
              <span className="badge badge-primary badge-sm absolute -top-1 right-0 translate-x-1/3 whitespace-nowrap shadow">
                着色中
              </span>
            )}
            <button
              ref={trigger}
              type="button"
              aria-label={`《${book.title}》的操作`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
              // 44 px is the smallest comfortable touch target on mobile.
              className="btn btn-circle btn-sm size-11 min-h-11 border-0 bg-base-100/85 backdrop-blur-sm hover:bg-base-100"
            >
              <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4" fill="currentColor">
                <circle cx="10" cy="4.5" r="1.6" />
                <circle cx="10" cy="10" r="1.6" />
                <circle cx="10" cy="15.5" r="1.6" />
              </svg>
            </button>
            {menuOpen && (
              <ul
                role="menu"
                className="dropdown-content menu z-20 mt-1 w-48 rounded-box bg-base-100 p-2 shadow-lg ring-1 ring-base-content/10"
                onKeyDown={moveMenuFocus}
              >
                <li role="none">
                  <button
                    ref={firstItem}
                    type="button"
                    role="menuitem"
                    disabled={coloring}
                    onClick={() => {
                      closeMenu();
                      onOpen(book.id);
                    }}
                  >
                    阅读
                  </button>
                </li>
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    // One job at a time, and the job holds the model: a second
                    // pass would queue behind it for hours and duplicate its
                    // work. Offering it disabled is clearer than a refusal.
                    disabled={anyJob}
                    title={anyJob ? "已有书在着色全书中，等它结束" : undefined}
                    onClick={() => {
                      closeMenu();
                      onColorize(book.id);
                    }}
                  >
                    着色全书
                  </button>
                </li>
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    // Exporting reads what the job writes: the chapter being
                    // analyzed right now would leave as a plain chapter, and
                    // the file would be a half-colored snapshot nobody asked
                    // for. Export once the job is over.
                    disabled={coloring}
                    title={coloring ? "着色全书中，完成后才能导出" : undefined}
                    onClick={() => {
                      closeMenu();
                      setExporting(true);
                    }}
                  >
                    导出着色后的图书
                  </button>
                </li>
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="text-error"
                    // The job is reading this book's file; removing it mid-job
                    // would leave the bar coloring a book that no longer
                    // exists. Cancel first, then remove.
                    disabled={coloring}
                    title={coloring ? "先取消着色全书，再移除" : undefined}
                    onClick={() => {
                      closeMenu();
                      setConfirming(true);
                    }}
                  >
                    从书架移除
                  </button>
                </li>
              </ul>
            )}
          </div>
        </div>

        <div className="min-w-0 px-0.5">
          {/* The heading wraps the button, not the other way round: a `h3` is
              not phrasing content and would be invalid inside a button. */}
          <h3 className="text-sm leading-snug font-medium">
            <button
              type="button"
              // The title is a second way to open the book, so it needs the
              // same rule as the cover: a job holds the book it is coloring.
              disabled={coloring}
              title={coloring ? "着色全书中，完成后才能打开" : undefined}
              className="line-clamp-2 w-full text-left break-words hover:underline disabled:cursor-not-allowed disabled:opacity-60 disabled:no-underline"
              onClick={() => onOpen(book.id)}
            >
              {book.title}
            </button>
          </h3>
          <p className="mt-0.5 truncate text-xs text-base-content/55">
            {book.authors.join(", ") || "未知作者"}
          </p>
        </div>
      </article>

      {exporting && (
        <ExportDialog
          open={exporting}
          id={book.id}
          title={book.title}
          onClose={() => setExporting(false)}
        />
      )}

      {/* daisyUI modal: removal deletes the imported copy, so ask first. */}
      {confirming && (
        <dialog
          ref={dialog}
          className="modal"
          aria-labelledby={`remove-title-${book.id}`}
          // Escape closes the element without going through `dismissConfirm`,
          // so the state has to follow the native close too.
          onClose={() => setConfirming(false)}
          onCancel={() => setConfirming(false)}
        >
          <div className="modal-box max-w-sm">
            <h4 id={`remove-title-${book.id}`} className="text-base font-semibold">
              移除《{book.title}》？
            </h4>
            <p className="mt-2 text-sm text-base-content/70">
              书架中保存的副本将被删除。之后你随时可以重新添加这个文件。
            </p>
            <div className="modal-action">
              <button type="button" className="btn btn-ghost" onClick={dismissConfirm}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-error"
                onClick={() => {
                  setConfirming(false);
                  onRemove(book.id);
                }}
              >
                移除
              </button>
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            className="modal-backdrop"
            onClick={dismissConfirm}
          />
        </dialog>
      )}
    </li>
  );
});
