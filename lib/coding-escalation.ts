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
  return `A review of their current implementation just wrapped and there is room for the next variant. Follow the Escalation rule in your phase guidance — it tells you to read current code first, check remainingMs for the time branch, and either run a full coding round (approach discussion first, then implement) or a verbal-only discussion. The variant: "${followUp.prompt}"`;
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
      "Everything passed. Before you respond, follow these steps in order: (1) Read the submitted code. (2) Check the Interviewer reference for whether a more efficient approach exists. (3) If the code is suboptimal compared to what the reference describes (e.g. nested loops when a hash-map single pass is possible): acknowledge it passes, then your question MUST be about reducing the time complexity — e.g. 'This is O(n²) — can you think of a way to get it to O(n)?' Do NOT ask about space, edge cases, correctness, or implementation details. Follow the SUBOPTIMAL BUT PASSING rule in your phase instructions. (4) Only if the code already uses a reasonable approach: ask ONE focused question about an edge case, correctness, or tradeoff."
    );
  } else {
    parts.push(
      "The solution is NOT correct yet. Open by naming the specific failing BEHAVIOUR from the failed hidden case description, ask the candidate to walk through what their code does in that situation, then tell them to fix it and re-submit. You do NOT have the hidden test's raw input or expected output — never invent or quote them. Stay on this bug; do NOT pose a harder follow-up, do NOT wrap up, and do NOT emit [segment-complete] — correctness comes before anything else."
    );
  }
  return parts.join(" ");
}
