import { useCallback, useEffect, useRef, useState } from "react";
import {
  type FontProgress,
  type FontStatus,
  fontInstall,
  fontRemove,
  fontStatus,
  onFontProgress,
} from "../lib/fonts";
import { message } from "../lib/reading";

export type FontOp = "install" | "remove" | null;

export interface SerifFontState {
  status: FontStatus | null;
  op: FontOp;
  progress: FontProgress | null;
  error: string | null;
  refresh: () => Promise<FontStatus | null>;
  install: () => Promise<FontStatus | null>;
  remove: () => Promise<FontStatus | null>;
}

function isFontStatus(value: unknown): value is FontStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FontStatus).installed === "boolean"
  );
}

/**
 * Shared controller for the on-demand Source Han Serif SC font.
 * Used both by Reader (download when selecting 思源宋体) and Settings (FontSection).
 */
export function useSerifFont(enabled = true): SerifFontState {
  const [status, setStatus] = useState<FontStatus | null>(null);
  const [op, setOp] = useState<FontOp>(null);
  const [progress, setProgress] = useState<FontProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<FontStatus | null> => {
    try {
      const next = await fontStatus();
      if (!isFontStatus(next)) return null;
      if (mountedRef.current) {
        setStatus(next);
        setError(null);
      }
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  const install = useCallback(async (): Promise<FontStatus | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    if (mountedRef.current) {
      setOp("install");
      setProgress(null);
      setError(null);
    }
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await onFontProgress((event) => {
        if (mountedRef.current) setProgress(event);
      });
      const next = await fontInstall();
      if (!isFontStatus(next)) return null;
      if (mountedRef.current) setStatus(next);
      return next;
    } catch (err) {
      if (mountedRef.current) setError(message(err));
      const refreshed = await fontStatus().catch(() => null);
      if (mountedRef.current && isFontStatus(refreshed)) setStatus(refreshed);
      return null;
    } finally {
      unlisten?.();
      busyRef.current = false;
      if (mountedRef.current) {
        setOp(null);
        setProgress(null);
      }
    }
  }, []);

  const remove = useCallback(async (): Promise<FontStatus | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    if (mountedRef.current) {
      setOp("remove");
      setError(null);
    }
    try {
      const next = await fontRemove();
      if (!isFontStatus(next)) return null;
      if (mountedRef.current) setStatus(next);
      return next;
    } catch (err) {
      if (mountedRef.current) setError(message(err));
      return null;
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setOp(null);
    }
  }, []);

  return { status, op, progress, error, refresh, install, remove };
}
