/**
 * Time-discipline thresholds for a round, derived from total round length.
 * Centralized so future round-length tiers (45 / 60 / 90 min) all behave correctly
 * without per-tier branching. See docs/progressive-rounds.md.
 *
 * Precedence rule: the follow-up floor wins. If `remaining <= followUpFloorMs`
 * we transition to follow-up immediately and skip any wrap-up budget.
 */

/** Reserved minimum for follow-up Q&A. Floor for 60-min round = 10 min. */
const FOLLOW_UP_FLOOR_RATIO = 1 / 6;

/** When still coding and remaining drops to this, force a verbal wrap-up. 60-min round = 15 min. */
const FORCED_STOP_TRIGGER_RATIO = 1 / 4;

export type RoundThresholds = {
  /** When still coding and remaining <= this, lock the editor and ask for a verbal final approach. */
  forcedStopTriggerMs: number;
  /** Hard floor: never enter follow-up with less than this. */
  followUpFloorMs: number;
  /** Time available for the verbal wrap-up between forced stop and the follow-up floor. */
  wrapUpBudgetMs: number;
};

export function getRoundThresholds(roundDurationMs: number): RoundThresholds {
  const forcedStopTriggerMs = Math.round(roundDurationMs * FORCED_STOP_TRIGGER_RATIO);
  const followUpFloorMs = Math.round(roundDurationMs * FOLLOW_UP_FLOOR_RATIO);
  const wrapUpBudgetMs = Math.max(0, forcedStopTriggerMs - followUpFloorMs);
  return { forcedStopTriggerMs, followUpFloorMs, wrapUpBudgetMs };
}
