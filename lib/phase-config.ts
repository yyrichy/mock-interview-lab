// Client-safe phase configuration constants. Kept in its own file so the
// client bundle does not have to import lib/ai.ts (which transitively pulls
// in every provider SDK).

import type { SessionPhase } from "./chat";

/** Soft budgets per phase (ms). Used to inject a one-time nudge when exceeded. */
export const PHASE_BUDGET_MS: Record<SessionPhase, number | null> = {
  clarifying: 5 * 60 * 1000,
  planning: 8 * 60 * 1000,
  coding: 35 * 60 * 1000,
  followUp: null,
  feedback: null,
};
