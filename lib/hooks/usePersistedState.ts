"use client";

import { useEffect, useRef, useState } from "react";

/**
 * useState backed by localStorage. On mount, attempts to restore a stored value
 * via `parse`; on each update, writes via `serialize`. The first persist after
 * a restore is suppressed so re-mounting doesn't overwrite a non-default value
 * with the initial state.
 *
 * `parse` returns `null` for "no valid stored value" — the hook keeps the
 * default in that case.
 */
export function usePersistedState<T>(
  key: string,
  defaultValue: T,
  parse: (raw: string) => T | null,
  serialize: (value: T) => string = String
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(defaultValue);
  const skipNextWrite = useRef(true);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored != null) {
        const parsed = parse(stored);
        if (parsed !== null) {
          setValue(parsed);
        }
      }
    } catch {
      /* private mode / denied */
    }
    // Intentionally only on mount: persistence keys are stable per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (skipNextWrite.current) {
      skipNextWrite.current = false;
      return;
    }
    try {
      localStorage.setItem(key, serialize(value));
    } catch {
      /* ignore */
    }
  }, [key, value, serialize]);

  return [value, setValue];
}
