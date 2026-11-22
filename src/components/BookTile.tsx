import { memo, useEffect, useRef, useState } from "react";
import type { Book } from "../lib/library";
import {
  bookColoringStatus,
  type BookColoringStatus,
  type ColoringProgress,
} from "../lib/reading";
import { ColoringOverlay } from "./ColoringOverlay";
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

type StatusState =
  | { kind: "loading" }
  | { kind: "ready"; data: BookColoringStatus }
  | { kind: "error" };

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
  // A running job holds this book: exporting, clearing or removing it would
  // race the analysis, so they are all refused while `progress` is set.
  const coloring = progress !== null;
  const [coverBroken, setCoverBroken] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Book's coloring coverage + model readiness, queried fresh each menu-open. */
  const [status, setStatus] = useState<StatusState>({ kind: "loading" });
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
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  // Query coloring coverage & model availability whenever the menu opens (or a
  // running job on this book finishes while the menu is open). Re-asking on
  // each open ensures model installs/switches, reader progress, and cache
  // clears are always reflected immediately with zero stale state.
  useEffect(() => {
    if (!menuOpen || coloring) return;
    let stale = false;
    setStatus({ kind: "loading" });
    bookColoringStatus(book.id)
      .then((data) => {
        if (!stale) setStatus({ kind: "ready", data });
      })
      .catch(() => {
        if (!stale) setStatus({ kind: "error" });
      });
    return () => {
      stale = true;
    };
  }, [menuOpen, book.id, coloring]);

  // A real modal, not just a dialog with the `open` attribute: the page behind
  // it is inert and focus is trapped until the user decides.
  useDialog(dialog, confirming !== null);

  /** Arrow keys walk the enabled menu items, as a `role="menu"` is expected to. */
  const moveMenuFocus = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'),
    ];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = index === -1 ? 0 : (index + step + items.length) % items.length;
    items[next]?.focus();
  };

  /** Dismisses the confirmation. The trigger is unmounted after a removal, so refocus first. */
  const dismissConfirm = () => {
    dialog.current?.close();
    setConfirming(null);
    trigger.current?.focus();
  };

  const showCover = cover !== undefined && !coverBroken;

  const info = status.kind === "ready" ? status.data : null;
  const isFull =
    info !== null &&
    info.hasModel &&
    info.totalChapters > 0 &&
    info.activeColored >= info.totalChapters;
  const isPartial =
    info !== null &&
    info.hasModel &&
    info.activeColored > 0 &&
    info.activeColored < info.totalChapters;

  // 1. 着色全书 / 取消着色全书
  let colorizeDisabled = false;
  let colorizeTitle: string | undefined;
  if (!coloring) {
    if (anyJob) {
      colorizeDisabled = true;
      colorizeTitle = "已有书在着色全书中，等它结束";
    } else if (status.kind === "error") {
      colorizeDisabled = true;
      colorizeTitle = "无法读取书籍着色状态";
    } else if (info === null) {
      colorizeDisabled = true;
    } else if (!info.hasModel) {
      colorizeDisabled = true;
      colorizeTitle = "请先在设置中下载模型";
    } else if (info.totalChapters === 0) {
      colorizeDisabled = true;
      colorizeTitle = "这本书没有可着色的章节";
    } else if (isFull) {
      colorizeDisabled = true;
      colorizeTitle = "全书已着色";
    } else if (isPartial) {
      colorizeTitle = `已着色 ${info.activeColored}/${info.totalChapters} 章，点击补齐剩余章节`;
    }
  }

  // 2. 导出着色后的图书 — strictly requires FULL coloring under active weights
  let exportDisabled = true;
  let exportTitle: string | undefined;
  if (coloring) {
    exportTitle = "着色全书中，完成后才能导出";
  } else if (status.kind === "error") {
    exportTitle = "无法读取书籍着色状态";
  } else if (info !== null) {
    if (!info.hasModel) {
      exportTitle = "请先在设置中下载模型";
    } else if (info.totalChapters === 0) {
      exportTitle = "这本书没有可导出的章节";
    } else if (isPartial) {
      exportTitle = `已着色 ${info.activeColored}/${info.totalChapters} 章，完成着色全书后才能导出`;
    } else if (!isFull) {
      exportTitle = "还没有着色，先着色全书再导出";
    } else {
      exportDisabled = false;
    }
  }

  // 3. 清除着色缓存 — enabled whenever any weights have markers (even without a model)
  let clearDisabled = true;
  let clearTitle: string | undefined;
  if (coloring) {
    clearTitle = "着色全书中，完成后才能清除";
  } else if (status.kind === "error") {
    clearTitle = "无法读取书籍着色状态";
  } else if (info !== null) {
    if (!info.hasAnyCache) {
      clearTitle = "还没有着色缓存";
    } else {
      clearDisabled = false;
    }
  }

  // 4. 从书架移除
  const removeDisabled = coloring;
  const removeTitle = coloring ? "先取消着色全书，再移除" : undefined;

  // Compact status line shown inside the menu so disabled reasons are visible
  // at a glance (including on touch devices and webviews where disabled buttons
  // suppress hover tooltips).
  let menuNote: string | null = null;
  if (!coloring && info !== null) {
    if (!info.hasModel) {
      menuNote = "请先在设置中下载模型";
    } else if (isFull) {
      menuNote = `全书已着色（${info.totalChapters} 章）`;
    } else if (isPartial) {
      menuNote = `已着色 ${info.activeColored}/${info.totalChapters} 章`;
    } else if (info.hasAnyCache) {
      menuNote = "当前模型尚未着色";
    }
  }

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

          {progress !== null && <ColoringOverlay progress={progress} />}

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
                {menuNote !== null && (
                  <li
                    role="none"
                    className="menu-title px-3 py-1 text-xs font-normal text-base-content/55"
                  >
                    {menuNote}
                  </li>
                )}
                <li role="none" title={colorizeTitle}>
                  <button
                    ref={firstItem}
                    type="button"
                    role="menuitem"
                    disabled={colorizeDisabled}
                    title={colorizeTitle}
                    onClick={() => {
                      closeMenu();
                      if (coloring) onCancel();
                      else onColorize(book.id);
                    }}
                  >
                    {coloring ? "取消着色全书" : "着色全书"}
                  </button>
                </li>
                <li role="none" title={exportTitle}>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={exportDisabled}
                    title={exportTitle}
                    onClick={() => {
                      closeMenu();
                      setExporting(true);
                    }}
                  >
                    导出着色后的图书
                  </button>
                </li>
                <li role="none" title={clearTitle}>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={clearDisabled}
                    title={clearTitle}
                    onClick={() => {
                      closeMenu();
                      setConfirming("clear-cache");
                    }}
                  >
                    清除着色缓存
                  </button>
                </li>
                <li role="none" title={removeTitle}>
                  <button
                    type="button"
                    role="menuitem"
                    className="text-error"
                    disabled={removeDisabled}
                    title={removeTitle}
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
