"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";

import { getSessionOpenAiKey } from "@/lib/byok-session";

// sessionStorage doesn't change underneath a gate decision, so subscribe no-ops;
// the snapshot just reads the key presence once per render.
const noopSubscribe = () => () => {};

/**
 * Gates the interview workspace when the demo is in BYOK / at-capacity mode.
 * A visitor with no own key in sessionStorage is redirected to /at-capacity
 * BEFORE InterviewWorkspace mounts, so the opening turn never fires on the
 * server key. When BYOK is off this is a transparent passthrough.
 *
 * The key is client-only (sessionStorage), so we read it via
 * useSyncExternalStore — the server snapshot is "no key", which avoids a
 * hydration mismatch — and show a brief placeholder until the client confirms.
 */
export function ByokGate({
  byokModeActive,
  questionId,
  children,
}: {
  byokModeActive: boolean;
  questionId: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const hasKey = useSyncExternalStore(
    noopSubscribe,
    () => getSessionOpenAiKey() != null,
    () => false
  );
  const allowed = !byokModeActive || hasKey;

  useEffect(() => {
    if (byokModeActive && !hasKey) {
      router.replace(`/at-capacity?questionId=${encodeURIComponent(questionId)}`);
    }
  }, [byokModeActive, hasKey, questionId, router]);

  if (!allowed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Checking availability…
      </div>
    );
  }
  return <>{children}</>;
}
