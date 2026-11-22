import { memo } from "react";
import type { BookView, TocEntry } from "../lib/reading";

function keyedTocItems(entries: readonly TocEntry[]): { key: string; entry: TocEntry }[] {
  const counts = new Map<string, number>();
  return entries.map((entry) => {
    const base = `${entry.chapterIndex ?? "x"}:${entry.anchor ?? ""}:${entry.label}`;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return { key: count === 0 ? base : `${base}#${count}`, entry };
  });
}

const TocItem = memo(function TocItem({
  item,
  currentIndex,
  coloredSet,
  onNavigate,
}: {
  item: TocEntry;
  currentIndex: number | null;
  coloredSet: ReadonlySet<number>;
  onNavigate: (chapterIndex: number, anchor: string | null) => void;
}) {
  const { chapterIndex } = item;
  const isActive = chapterIndex !== null && chapterIndex === currentIndex && !item.anchor;
  const isColored = chapterIndex !== null && coloredSet.has(chapterIndex);
  return (
    <li>
      {chapterIndex !== null ? (
        <button
          type="button"
          className={isActive ? "menu-active" : undefined}
          onClick={() => onNavigate(chapterIndex, item.anchor)}
        >
          <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
          {isColored && (
            <span
              role="img"
              className="badge badge-xs badge-primary shrink-0"
              title="已完成着色"
              aria-label="已着色"
            />
          )}
        </button>
      ) : (
        <span className="menu-title">{item.label}</span>
      )}
      {item.subitems.length > 0 && (
        <ul>
          {keyedTocItems(item.subitems).map(({ key, entry }) => (
            <TocItem
              key={key}
              item={entry}
              currentIndex={currentIndex}
              coloredSet={coloredSet}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </li>
  );
});

interface Props {
  book: BookView | null;
  currentIndex: number | null;
  coloredSet: ReadonlySet<number>;
  onNavigate: (chapterIndex: number, anchor: string | null) => void;
  onClose: () => void;
}

export const ReaderTocDrawer = memo(function ReaderTocDrawer({
  book,
  currentIndex,
  coloredSet,
  onNavigate,
  onClose,
}: Props) {
  return (
    <div className="drawer-side z-40">
      <label htmlFor="reader-toc-drawer" aria-label="关闭目录" className="drawer-overlay" />
      <nav
        aria-label="章节目录"
        className="flex h-full w-80 max-w-[85vw] flex-col bg-base-100 text-base-content shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-base-content/10 px-4 py-3">
          <h2 className="text-sm font-semibold">目录</h2>
          <button type="button" className="btn btn-ghost btn-xs" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {book && (
            <ul className="menu w-full flex-nowrap">
              {book.toc.length > 0
                ? keyedTocItems(book.toc).map(({ key, entry }) => (
                    <TocItem
                      key={key}
                      item={entry}
                      currentIndex={currentIndex}
                      coloredSet={coloredSet}
                      onNavigate={onNavigate}
                    />
                  ))
                : book.chapters.map((entry) => (
                    <li key={entry.index}>
                      <button
                        type="button"
                        className={entry.index === currentIndex ? "menu-active" : undefined}
                        onClick={() => onNavigate(entry.index, null)}
                      >
                        <span className="min-w-0 flex-1 truncate text-left">
                          {entry.title ?? `第 ${entry.index + 1} 节`}
                        </span>
                        {entry.colored && (
                          <span
                            role="img"
                            className="badge badge-xs badge-primary shrink-0"
                            title="已完成着色"
                            aria-label="已着色"
                          />
                        )}
                      </button>
                    </li>
                  ))}
            </ul>
          )}
        </div>
      </nav>
    </div>
  );
});
