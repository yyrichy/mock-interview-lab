import type { PersistedInterviewSession } from "@/lib/interview-session-storage";

export function saveLocalDebugSnapshot(
  session: PersistedInterviewSession
): void {
  if (process.env.NODE_ENV !== "development") return;

  void fetch("/api/local-debug/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(session),
  })
    .then((response) => {
      if (!response.ok) {
        console.warn(
          `[local-debug-archive] Snapshot save failed (${response.status}).`
        );
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[local-debug-archive] Snapshot save failed: ${message}`);
    });
}
