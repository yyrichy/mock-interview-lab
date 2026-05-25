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
  return `Follow-up trigger: they finished a short verbal review of their current implementation. Introduce this banked follow-up variant and ask them to implement it in the editor (they should update their code and run tests): "${followUp.prompt}"`;
}
