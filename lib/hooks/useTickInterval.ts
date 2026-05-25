"use client";

import { useEffect, useState } from "react";

/**
 * Re-renders the host component every `intervalMs` while `active` is true,
 * returning the current timestamp. Use to drive remaining-time UIs without
 * managing your own setInterval boilerplate.
 *
 * The tick is stable when `active` is false (returns the last value), so
 * derived "remaining" computations don't bounce to 0.
 */
export function useTickInterval(active: boolean, intervalMs = 1000): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return tick;
}
