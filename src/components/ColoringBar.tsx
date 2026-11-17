import type { ColoringProgress } from "../lib/reading";

interface Props {
  /** The job, or null when there is only a problem to report. */
  progress: ColoringProgress | null;
  /** The book's title, for a bar that names what it is coloring. */
  title: string;
  /** A failure that never became a job (starting it was refused, for example). */
  problem: string | null;
  onCancel: () => void;
  onDismiss: () => void;
}

/**
 * The shelf's coloring bar.
 *
 * It sits in the app header, not in a modal: coloring a book is hours of work
 * and the whole point is that it does not interrupt anything — the bar is the
 * only trace of it while other books are read.
 *
 * Progress counts sentences rather than chapters because that is what the work
 * is: the model analyzes sentence by sentence and the cache is keyed by them, so
 * a one-line heading must not weigh like a 2 000-character block. Chapters
 * still vary from a title page to a 200-page part — a chapter bar would sit at
 * 40 % and then jump — so `chapters` is shown next to it for orientation.
 */
export function ColoringBar({ progress, title, problem, onCancel, onDismiss }: Props) {
  if (problem !== null) {
    return (
      <div role="alert" className="alert alert-error alert-soft mx-auto mb-2 w-full max-w-6xl py-2">
        <p className="min-w-0 flex-1 text-sm break-words">着色全书没能开始：{problem}</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
          知道了
        </button>
      </div>
    );
  }
  if (progress === null) return null;

  const percent =
    progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const done = progress.finished;
  const failed = done && progress.error !== null;

  return (
    <div
      // `status`, not `alert`: a finished job is news, and a background job must
      // not interrupt whatever a screen reader is saying about the shelf.
      role="status"
      aria-label="着色进度"
      className={`w-full rounded-box px-3 py-2 ${failed ? "bg-error/10" : "bg-base-200/70"}`}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate">
          {done
            ? failed
              ? `《${title}》着色全书中断：${progress.error}`
              : progress.cancelled
                ? `《${title}》着色全书已停止 · ${progress.chapters}/${progress.chaptersTotal} 章`
                : `《${title}》着色全书完成`
            : `《${title}》着色全书中 · ${percent}% · ${progress.chapters}/${progress.chaptersTotal} 章`}
        </span>
        {done ? (
          <button type="button" className="btn btn-ghost btn-xs" onClick={onDismiss}>
            关闭
          </button>
        ) : (
          <button type="button" className="btn btn-ghost btn-xs" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
      <progress
        className={`progress mt-1.5 w-full ${failed ? "progress-error" : "progress-primary"}`}
        // `max` is the book's sentence count; a bar with no total is either an
        // empty book or a job that has not parsed one yet, and 0 would be an
        // invalid range.
        value={progress.done}
        max={Math.max(progress.total, 1)}
      />
    </div>
  );
}
