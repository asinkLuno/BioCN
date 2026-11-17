import { useCallback, useEffect, useState } from "react";
import {
  cancelColorizeBook,
  colorizeBook,
  coloringProgress,
  message,
  onColoringProgress,
  type ColoringProgress,
} from "../lib/reading";

/**
 * The whole-book coloring job, as the shelf sees it.
 *
 * There is at most one job (`src-tauri/src/analyzer.rs` keeps a single one), so
 * this holds a single value rather than a map. The job lives in Rust and
 * survives this component, which is why the state is *read* on mount as well as
 * subscribed to: a renderer that reloaded mid-job must show the bar it missed
 * the start of.
 *
 * `finished` stays set until dismissed: "it stopped" is news, and a bar that
 * vanished at 100 % would be indistinguishable from one that never ran. A book
 * is only locked while a job is running, so dismissing is cosmetic.
 */
export function useColoring() {
  const [job, setJob] = useState<ColoringProgress | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      try {
        // Subscribe first: a job started before this effect still emits, and
        // the read below may already be the finished one.
        const off = await onColoringProgress((progress) => {
          if (!cancelled) setJob(progress);
        });
        if (cancelled) off();
        else unsubscribe = off;

        const current = await coloringProgress();
        // A backend that answers `null` and a harness whose `invoke` is a stub
        // that answers nothing both mean "no job": neither may become one.
        if (!cancelled && current) setJob(current);
      } catch {
        // Progress is a nicety: a shelf that cannot subscribe still browses,
        // reads and removes books.
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const start = useCallback(async (id: string) => {
    setProblem(null);
    try {
      await colorizeBook(id);
    } catch (error) {
      setProblem(message(error));
      return;
    }
    // The job's first event is emitted while the command is still running. It
    // should arrive here, but "should" is not a reason to leave the user with
    // a disabled book and no bar: ask once, and the answer is at least as new
    // as anything the subscription delivered.
    try {
      const started = await coloringProgress();
      if (started) setJob(started);
    } catch {
      // The event path is still live; this was the belt.
    }
  }, []);

  const cancel = useCallback(async () => {
    try {
      await cancelColorizeBook();
    } catch (error) {
      setProblem(message(error));
    }
  }, []);

  const dismiss = useCallback(() => {
    setProblem(null);
    // Only a job that is over can be dismissed: the "知道了" button on a
    // failed cancel must not hide a bar for work that is still running, or the
    // book would look idle and stay locked with nothing on screen to explain
    // it.
    setJob((job) => (job !== null && job.finished ? null : job));
  }, []);

  return { job, problem, start, cancel, dismiss };
}
