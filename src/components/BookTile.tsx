import { memo, useEffect, useId, useRef, useState } from "react";
import type { Book } from "../lib/library";
import { bookHasColoring, bookHasActiveColoring, type ColoringProgress } from "../lib/reading";
import { ExportDialog } from "./ExportDialog";
import { useDialog, ModalBackdrop } from "./dialog";

interface Props {
  book: Book;
  cover?: string;
  /** This book's running job, or null: its only trace lives on this tile. */
  progress: ColoringProgress | null;
  /** Any job at all is running, so a second 着色全书 would be refused. */
  anyJob: boolean;
  onOpen: (id: string) => void;
  onColorize: (id: string) => void;
  onCancel: () => void;
  onClearCache: (id: string) => void;
  onRemove: (id: string) => void;
}

/** What the confirmation dialog is asking about, or that none is open. */
type Confirming = "remove" | "clear-cache" | null;

/** Wrapping in a memo is what keeps a shelf worth of tiles from re-rendering
    when one tile's cover loads or its menu opens. */
export const BookTile = memo(function BookTile({
  book,
  cover,
  progress,
  anyJob,
  onOpen,
  onColorize,
  onCancel,
  onClearCache,
  onRemove,
}: Props) {
  // A running job holds this book: opening, exporting, clearing or removing it
  // would race the analysis, so they are all refused while `progress` is set.
  const coloring = progress !== null;
  const helixUid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [coverBroken, setCoverBroken] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Whether this book has coloring to clear, asked each time the menu opens. */
  const [hasColoring, setHasColoring] = useState<boolean | null>(null);
  /** …and coloring under the *active* weights, which is what an export reads. */
  const [hasActiveColoring, setHasActiveColoring] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
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
    // 清除着色缓存 and 导出着色后的图书 may only be offered when this book
    // has coloring — to clear, any weights' markers; to export, the active
    // weights' (the only slice the exporter reads). The answers have to be
    // current when an item is clicked, so they are asked here, at menu-open,
    // not carried over from an earlier look.
    let stale = false;
    setHasColoring(null);
    setHasActiveColoring(null);
    const settle = (asked: Promise<boolean>, got: (value: boolean) => void) => {
      asked
        // A failed check must not hide the item it feeds: clearing an empty
        // cache is a harmless no-op, exporting an uncolored book writes an
        // honest plain copy, while a hidden item looks like a missing one.
        .then((value) => {
          if (!stale) got(value);
        })
        .catch(() => {
          if (!stale) got(true);
        });
    };
    settle(bookHasColoring(book.id), setHasColoring);
    settle(bookHasActiveColoring(book.id), setHasActiveColoring);
    return () => {
      stale = true;
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, book.id]);

  // A real modal, not just a dialog with the `open` attribute: the page behind
  // it is inert and focus is trapped until the user decides.
  useDialog(dialog, confirming !== null);

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
    setConfirming(null);
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
            className="group block h-full w-full cursor-pointer focus:outline-none"
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

          {progress !== null && (
            // Full-cover overlay for the running whole-book coloring job: the
            // frosted veil + centered brand helix covers the entire cover while
            // staying `pointer-events-none` so clicking the cover still opens
            // the book and the top-right menu stays reachable above it.
            <div
              role="status"
              aria-label="着色进度"
              className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between bg-base-100/75 p-3 backdrop-blur-sm"
            >
              {/* 居中放大展示品牌双螺旋内联 SVG 动画（与 design/logo/biocn-helix-launch.svg 同一标记），
                  通过中段 clipPath 与纵深渐变呈现「绿压橙 → 橙压绿 → 绿压橙」3D 穿插；
                  进度信息由底部的进度条与百分比承担。 */}
              <div className="flex flex-1 items-center justify-center pt-4">
                <svg
                  aria-hidden="true"
                  data-helix-loader=""
                  viewBox="0 0 100 100"
                  className="aspect-square w-3/5 max-w-32"
                >
                  <defs>
                    <clipPath id={`biocn-${helixUid}-over-mid`}>
                      <rect x="34" y="37" width="32" height="20" />
                    </clipPath>
                    <linearGradient
                      id={`biocn-${helixUid}-grad-o`}
                      gradientUnits="userSpaceOnUse"
                      x1="0"
                      y1="89"
                      x2="0"
                      y2="11.5"
                    >
                      <stop offset="0%" stopColor="#d95f02" />
                      <stop offset="13%" stopColor="#d95f02" />
                      <stop offset="18%" stopColor="#b84e00" />
                      <stop offset="23%" stopColor="#d95f02" />
                      <stop offset="85%" stopColor="#d95f02" />
                      <stop offset="90%" stopColor="#b84e00" />
                      <stop offset="95%" stopColor="#d95f02" />
                      <stop offset="100%" stopColor="#d95f02" />
                    </linearGradient>
                    <linearGradient
                      id={`biocn-${helixUid}-grad-g`}
                      gradientUnits="userSpaceOnUse"
                      x1="0"
                      y1="89"
                      x2="0"
                      y2="11.5"
                    >
                      <stop offset="0%" stopColor="#1b9e77" />
                      <stop offset="49%" stopColor="#1b9e77" />
                      <stop offset="54%" stopColor="#147e5e" />
                      <stop offset="59%" stopColor="#1b9e77" />
                      <stop offset="100%" stopColor="#1b9e77" />
                    </linearGradient>
                  </defs>
                  <line
                    className="biocn-helix-rung biocn-helix-rung-1"
                    pathLength={100}
                    x1="72"
                    y1="87"
                    x2="28"
                    y2="87"
                  />
                  <line
                    className="biocn-helix-rung biocn-helix-rung-2"
                    pathLength={100}
                    x1="28"
                    y1="61"
                    x2="72"
                    y2="61"
                  />
                  <line
                    className="biocn-helix-rung biocn-helix-rung-3"
                    pathLength={100}
                    x1="72"
                    y1="33"
                    x2="28"
                    y2="33"
                  />
                  <path
                    className="biocn-helix-strand biocn-helix-strand-o"
                    stroke={`url(#biocn-${helixUid}-grad-o)`}
                    pathLength={100}
                    d="M 73 89 C 73 78.4 27 71.6 27 61 C 27 50.4 73 43.6 73 33 C 73 24.7 45 18.8 32.7 11.5"
                  />
                  <path
                    className="biocn-helix-strand biocn-helix-strand-g"
                    stroke={`url(#biocn-${helixUid}-grad-g)`}
                    pathLength={100}
                    d="M 27 89 C 27 78.4 73 71.6 73 61 C 73 50.4 27 43.6 27 33 C 27 24.7 55 18.8 67.3 11.5"
                  />
                  <path
                    className="biocn-helix-strand biocn-helix-strand-o"
                    stroke={`url(#biocn-${helixUid}-grad-o)`}
                    clipPath={`url(#biocn-${helixUid}-over-mid)`}
                    pathLength={100}
                    d="M 73 89 C 73 78.4 27 71.6 27 61 C 27 50.4 73 43.6 73 33 C 73 24.7 45 18.8 32.7 11.5"
                  />
                </svg>
              </div>
              <div className="flex w-full items-center gap-2">
                {progress.total > 0 ? (
                  <progress
                    className="progress progress-primary h-2 min-w-0 flex-1"
                    value={progress.done}
                    max={progress.total}
                  />
                ) : (
                  <progress className="progress progress-primary h-2 min-w-0 flex-1" />
                )}
                <span className="shrink-0 text-xs font-medium tabular-nums">
                  {progress.total > 0
                    ? `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%`
                    : "准备中…"}
                </span>
              </div>
            </div>
          )}

          <div ref={menuRoot} className="dropdown dropdown-end absolute top-2 right-2 z-20">
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
                    // One job at a time, and the job holds the model: a second
                    // pass would queue behind it for hours and duplicate its
                    // work. Offering it disabled is clearer than a refusal.
                    // The one job it can be is this book's, and then the item
                    // is its cancel button — the strip on the tile deliberately
                    // carries no controls.
                    disabled={progress === null && anyJob}
                    title={progress === null && anyJob ? "已有书在着色全书中，等它结束" : undefined}
                    onClick={() => {
                      closeMenu();
                      if (coloring) onCancel();
                      else onColorize(book.id);
                    }}
                  >
                    {coloring ? "取消着色全书" : "着色全书"}
                  </button>
                </li>
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    // Exporting reads only the active weights' slice, and it
                    // reads what the job writes: without coloring under these
                    // weights the file would be the plain book back out, and
                    // the chapter being analyzed right now would leave as a
                    // plain chapter. Export once there is something colored
                    // and the job is over.
                    disabled={coloring || hasActiveColoring !== true}
                    title={
                      coloring
                        ? "着色全书中，完成后才能导出"
                        : hasActiveColoring === false
                          ? "还没有着色，先着色全书再导出"
                          : undefined
                    }
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
                    // Grey until there is something to clear, and while the job
                    // is writing exactly the rows a clear deletes: clearing
                    // mid-job would leave the strip finishing over a book that
                    // shows no coloring.
                    disabled={coloring || hasColoring !== true}
                    title={
                      coloring
                        ? "着色全书中，完成后才能清除"
                        : hasColoring === false
                          ? "还没有着色缓存"
                          : undefined
                    }
                    onClick={() => {
                      closeMenu();
                      setConfirming("clear-cache");
                    }}
                  >
                    清除着色缓存
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
                      setConfirming("remove");
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
              className="line-clamp-2 w-full text-left break-words hover:underline"
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
          id={book.id}
          title={book.title}
          onClose={() => setExporting(false)}
        />
      )}

      {/* daisyUI modal: both actions delete work the user paid for, so ask
          first. */}
      {confirming && (
        <dialog
          ref={dialog}
          className="modal"
          aria-labelledby={`${confirming}-title-${book.id}`}
          // Escape closes the element without going through `dismissConfirm`,
          // so the state has to follow the native close too.
          onClose={() => setConfirming(null)}
          onCancel={() => setConfirming(null)}
        >
          <div className="modal-box max-w-sm">
            {confirming === "remove" ? (
              <>
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
                      setConfirming(null);
                      onRemove(book.id);
                    }}
                  >
                    移除
                  </button>
                </div>
              </>
            ) : (
              <>
                <h4 id={`clear-cache-title-${book.id}`} className="text-base font-semibold">
                  清除《{book.title}》的着色缓存？
                </h4>
                <p className="mt-2 text-sm text-base-content/70">
                  已保存的着色结果将被删除，再次阅读或着色全书时会重新分析（需要模型计算）。
                  换过模型变体时，旧变体的缓存也会一并清除。
                </p>
                <div className="modal-action">
                  <button type="button" className="btn btn-ghost" onClick={dismissConfirm}>
                    取消
                  </button>
                  {/* `warning`, not `error`: the loss is real but recoverable —
                      re-analysis rebuilds everything, unlike removal. */}
                  <button
                    type="button"
                    className="btn btn-warning"
                    onClick={() => {
                      setConfirming(null);
                      onClearCache(book.id);
                    }}
                  >
                    清除
                  </button>
                </div>
              </>
            )}
          </div>
          <ModalBackdrop onClose={dismissConfirm} />
        </dialog>
      )}
    </li>
  );
});
