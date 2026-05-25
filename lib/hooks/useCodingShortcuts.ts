"use client";

import { useEffect } from "react";

import type { SessionPhase } from "@/lib/chat";

/**
 * Registers Ctrl/Cmd+Enter (run tests) while the editor is unlocked, and
 * Ctrl/Cmd+D (mark done) while the coding phase is active. Shortcuts are ignored
 * while a test run or AI stream is in flight. All conditions are read from refs
 * so the effect can mount once.
 */
export function useCodingShortcuts(opts: {
  sessionPhaseRef: React.MutableRefObject<SessionPhase>;
  testRunLoadingRef: React.MutableRefObject<boolean>;
  isStreamingRef: React.MutableRefObject<boolean>;
  onRunTests: () => void;
  onImDone: () => void;
}): void {
  const {
    sessionPhaseRef,
    testRunLoadingRef,
    isStreamingRef,
    onRunTests,
    onImDone,
  } = opts;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "enter") {
        if (
          sessionPhaseRef.current !== "coding" &&
          sessionPhaseRef.current !== "followUp"
        ) {
          return;
        }
        if (testRunLoadingRef.current) return;
        e.preventDefault();
        onRunTests();
        return;
      }
      if (key === "d") {
        if (sessionPhaseRef.current !== "coding") return;
        if (isStreamingRef.current) return;
        e.preventDefault();
        onImDone();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessionPhaseRef, testRunLoadingRef, isStreamingRef, onRunTests, onImDone]);
}
