"use client";

import { useEffect, useState } from "react";

/**
 * Autosaves editor code to localStorage every 30s while `phase` matches `whilePhase`
 * (typically "coding"), and clears the entry when `phase` reaches `clearOnPhase`
 * (typically "feedback"). Restores any saved value on mount; falls back to
 * `defaultValue` when nothing is saved.
 *
 * Returns `[initialValue, resetToDefault]`. `resetToDefault` is for explicit
 * session reset — clears the stored value and pushes the default back to the
 * caller via the returned setter.
 */
export function useCodeAutosave<Phase extends string>(
  storageKey: string,
  defaultValue: string,
  getCode: () => string,
  phase: Phase,
  whilePhase: Phase,
  clearOnPhase: Phase
): [string, (initial: string) => void, () => void] {
  const [initialValue, setInitialValue] = useState<string>(() => {
    if (typeof window === "undefined") return defaultValue;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved && saved.length > 0) {
        return saved;
      }
    } catch {
      /* ignore */
    }
    return defaultValue;
  });

  useEffect(() => {
    if (phase !== whilePhase) return;
    const id = window.setInterval(() => {
      try {
        const code = getCode();
        if (code && code !== defaultValue) {
          localStorage.setItem(storageKey, code);
        }
      } catch {
        /* quota / private mode */
      }
    }, 30_000);
    return () => window.clearInterval(id);
  }, [phase, whilePhase, getCode, defaultValue, storageKey]);

  useEffect(() => {
    if (phase !== clearOnPhase) return;
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }, [phase, clearOnPhase, storageKey]);

  function clearSaved(): void {
    setInitialValue(defaultValue);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }

  return [initialValue, setInitialValue, clearSaved];
}
