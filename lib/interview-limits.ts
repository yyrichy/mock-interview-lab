/** Max Judge0 test runs allowed per session. */
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
