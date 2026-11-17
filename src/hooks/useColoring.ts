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
 * subscribed to: a renderer that reloaded mid-job must show the strip it missed
 * the start of.
 *
 * `job` only ever holds a *running* job: a finished one is absorbed instead —
 * done and cancelled leave no trace (the strip on the book tile just goes), and
 * a failure becomes a `problem`, because "it stopped" is only news when it
 * went wrong.
 */
export function useColoring() {
  const [job, setJob] = useState<ColoringProgress | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const absorb = useCallback((progress: ColoringProgress | null) => {
    if (progress === null) return;
    if (!progress.finished) {
      setJob(progress);
      return;
    }
    // The job is over either way; only a failure has something to say.
    setJob(null);
    if (progress.error !== null) setProblem(`着色全书中断：${progress.error}`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      try {
        // Subscribe first: a job started before this effect still emits, and
        // the read below may already be the finished one.
        const off = await onColoringProgress((progress) => {
          if (!cancelled) absorb(progress);
        });
        if (cancelled) off();
        else unsubscribe = off;

        absorb(await coloringProgress());
      } catch {
        // Progress is a nicety: a shelf that cannot subscribe still browses,
        // reads and removes books.
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [absorb]);

  const start = useCallback(
    async (id: string) => {
      setProblem(null);
      try {
        await colorizeBook(id);
      } catch (error) {
        setProblem(`着色全书没能开始：${message(error)}`);
        return;
      }
      // The job's first event is emitted while the command is still running. It
      // should arrive here, but "should" is not a reason to leave the user with
      // a disabled book and no strip: ask once, and the answer is at least as
      // new as anything the subscription delivered.
      try {
        absorb(await coloringProgress());
      } catch {
        // The event path is still live; this was the belt.
      }
    },
    [absorb],
  );

  const cancel = useCallback(async () => {
    try {
      await cancelColorizeBook();
    } catch (error) {
      setProblem(`没能取消着色全书：${message(error)}`);
    }
  }, []);

  const dismissProblem = useCallback(() => setProblem(null), []);

  return { job, problem, start, cancel, dismissProblem };
}
