import type { FollowUp } from "@/lib/questions";

export type BankedEscalationSource = "after_slice_review";

export type PendingBankedFollowUp = {
  followUp: FollowUp;
  index: number;
};

/**
 * Next banked in-code variant that has not been scheduled yet.
 * Requires baseline visible tests to have passed at least once.
 */
export function getPendingBankedFollowUp(
  followUps: FollowUp[] | undefined,
  currentIndex: number,
  baselineSolvedAt: number | null,
  remainingMs: number
): PendingBankedFollowUp | null {
  const list = followUps ?? [];
  if (baselineSolvedAt === null) {
    return null;
  }
  if (currentIndex >= list.length) {
    return null;
  }
  const followUp = list[currentIndex];
  if (remainingMs < followUp.expectedMinutes * 60_000) {
    return null;
  }
  return { followUp, index: currentIndex };
}

export function buildBankedEscalationHint(followUp: FollowUp): string {
  return `A review of their current implementation just wrapped and there is room for the next variant. FIRST, silently read their current code (read_current_code). If their existing solution ALREADY satisfies this variant, do NOT re-ask it — briefly credit them for seeing it coming, then end the turn with the token [segment-complete] on its own final line so we move on. Otherwise, introduce this variant as ONE concrete ask in interviewer voice — a short "Nice — now…" bridge, then the single ask — and let them implement it in the editor (update code, then Submit): "${followUp.prompt}"`;
}

/**
 * Counts-only review hint for the turn a candidate Submit triggers. Carries
 * aggregate pass/fail counts plus the human-readable DESCRIPTIONS of failed
 * hidden cases — never raw hidden input/expected/actual (the model is told it
 * does not have them). Drives the post-pass acknowledgment or the ground-truth
 * failure probe.
 */
export function buildSubmitReviewHint(args: {
  visiblePassed: boolean;
  hiddenPassed: boolean;
  visiblePassedCount: number;
  visibleTotal: number;
  hiddenPassedCount: number;
  hiddenTotal: number;
  failedHiddenDescriptions: string[];
}): string {
  const parts: string[] = [
    `Submit grade: ${args.visiblePassedCount}/${args.visibleTotal} visible passed; ${args.hiddenPassedCount}/${args.hiddenTotal} hidden passed.`,
  ];
  if (!args.hiddenPassed && args.failedHiddenDescriptions.length > 0) {
    parts.push(`Failed hidden case(s): ${args.failedHiddenDescriptions.join("; ")}.`);
  }
  if (args.visiblePassed && args.hiddenPassed) {
    parts.push(
      "Everything passed. Open by briefly acknowledging it works, then ask ONE focused question about THIS solution — an edge case, correctness, or its time/space."
    );
  } else {
    parts.push(
      "The solution is NOT correct yet. Open by naming the specific failing BEHAVIOUR from the failed hidden case description, ask the candidate to walk through what their code does in that situation, then tell them to fix it and re-submit. You do NOT have the hidden test's raw input or expected output — never invent or quote them. Stay on this bug; do NOT pose a harder follow-up, do NOT wrap up, and do NOT emit [segment-complete] — correctness comes before anything else."
    );
  }
  return parts.join(" ");
}
