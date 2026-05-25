/** Timing constants for the follow-up phase auto-close threshold and per-slice turn limits. */

/** Auto-close the follow-up segment when remaining round time drops at or below this. */
export const FOLLOW_UP_AUTO_CLOSE_REMAINING_MS = 2 * 60 * 1000;

/** Max interviewer turns in a slice review before wrap-up (includes opener). */
export const FOLLOW_UP_SLICE_SAFETY_CAP = 6;

/** From this many prior interviewer turns in the slice, warn against new questions. */
export const FOLLOW_UP_SLICE_SOFT_WARN_AT = 4;

/** From this count, the model should prefer wrap-up over a new question. */
export const FOLLOW_UP_SLICE_LAST_QUESTION_AT = 5;
