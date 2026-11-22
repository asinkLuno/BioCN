import { memo } from "react";
import type { BookView, TocEntry } from "../lib/reading";

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
  const isActive = item.chapterIndex !== null && item.chapterIndex === currentIndex && !item.anchor;
  const isColored = item.chapterIndex !== null && coloredSet.has(item.chapterIndex);
  return (
    <li>
      {item.chapterIndex !== null ? (
        <button
          type="button"
          className={isActive ? "menu-active" : undefined}
          onClick={() => onNavigate(item.chapterIndex!, item.anchor)}
        >
          <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
          {isColored && (
            <span
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
          {item.subitems.map((child, idx) => (
            <TocItem
              key={`${child.label}-${idx}`}
              item={child}
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
                ? book.toc.map((entry, idx) => (
                    <TocItem
                      key={`${entry.label}-${idx}`}
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
