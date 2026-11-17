import { useEffect, useRef, useState } from "react";
import type { Book } from "../lib/library";

interface Props {
  book: Book;
  cover?: string;
  onRemove: (id: string) => void;
}

export function BookTile({ book, cover, onRemove }: Props) {
  const [coverBroken, setCoverBroken] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
        <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-base-200 ring-1 ring-base-content/10">
          {showCover ? (
            <img
              src={cover}
              alt=""
              loading="lazy"
              onError={() => setCoverBroken(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full items-center justify-center p-4 text-base-content/35">
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
            </div>
          )}

          <div ref={menuRoot} className="dropdown dropdown-end absolute top-2 right-2">
            <button
              ref={trigger}
              type="button"
              aria-label={`Actions for ${book.title}`}
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
                    className="text-error"
                    onClick={() => {
                      closeMenu();
                      setConfirming(true);
                    }}
                  >
                    Remove from library
                  </button>
                </li>
              </ul>
            )}
          </div>
        </div>

        <div className="min-w-0 px-0.5">
          <h3 className="line-clamp-2 text-sm leading-snug font-medium break-words">
            {book.title}
          </h3>
          <p className="mt-0.5 truncate text-xs text-base-content/55">
            {book.authors.join(", ") || "Unknown author"}
          </p>
        </div>
      </article>

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
              Remove “{book.title}”?
            </h4>
            <p className="mt-2 text-sm text-base-content/70">
              The copy stored in your library is deleted. You can add the file again any time.
            </p>
            <div className="modal-action">
              <button type="button" className="btn btn-ghost" onClick={dismissConfirm}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-error"
                onClick={() => {
                  setConfirming(false);
                  onRemove(book.id);
                }}
              >
                Remove
              </button>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            className="modal-backdrop"
            onClick={dismissConfirm}
          />
        </dialog>
      )}
    </li>
  );
}
