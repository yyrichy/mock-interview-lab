"use client";

import { useEffect } from "react";

import {
  savePersistedInterviewSession,
  type PersistedInterviewSession,
} from "@/lib/interview-session-storage";
import { saveLocalDebugSnapshot } from "@/lib/local-debug-client";

const AUTOSAVE_MS = 30_000;

/**
 * Periodically persists the full interview session while `enabled` is true
 * (from first opening message until feedback finishes and persistence is cleared).
 */
export function useInterviewSessionAutosave(
  enabled: boolean,
  collectRef: React.MutableRefObject<() => PersistedInterviewSession>
): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const tick = () => {
      try {
        const session = collectRef.current();
        savePersistedInterviewSession(session);
        saveLocalDebugSnapshot(session);
      } catch {
        /* ignore */
      }
    };
    tick();
    const id = window.setInterval(tick, AUTOSAVE_MS);
    return () => window.clearInterval(id);
  }, [enabled, collectRef]);
}
