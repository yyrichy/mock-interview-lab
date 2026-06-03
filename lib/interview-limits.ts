/**
 * Max Judge0 executions per session. Run (visible self-check) and Submit
 * (visible+hidden grade) draw from this one shared counter so total Judge0 cost
 * is bounded. Run is hard-blocked once the cap is hit; Submit is NEVER blocked
 * ("free submission" — the candidate can always say "evaluate me"), it just
 * still increments the counter for cost visibility.
 */
export const TEST_RUNS_MAX = 10;

/** Hard cap on follow-up turns per session. Agent cannot exceed this. */
export const FOLLOW_UP_SAFETY_CAP = 40;

/** Total interview round duration. */
export const ROUND_DURATION_MS = 60 * 60 * 1000;

/**
 * Max output tokens for a single interviewer turn (POST /api/interviewer).
 * Interview turns are short by design — a sentence or two plus one question, or
 * a brief post-test review (acknowledge pass/fail + one focused question) — so
 * this bounds a runaway generation from inflating cost on the hosted demo's
 * metered key. It is intentionally NOT applied to the written feedback path
 * (POST /api/feedback runs through the provider adapters, not streamText), which
 * may legitimately be much longer. Raise this if a reasoning-heavy caller ever
 * truncates a normal turn.
 */
export const INTERVIEWER_MAX_OUTPUT_TOKENS = 500;
