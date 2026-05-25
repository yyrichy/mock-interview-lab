/**
 * Follow-up phase now runs until the round clock is nearly out instead of a
 * hard turn cap. These constants tune the auto-close threshold and a guardrail
 * upper bound so a runaway loop cannot fire indefinitely.
 */

/** Auto-close the follow-up segment when remaining round time drops at or below this. */
export const FOLLOW_UP_AUTO_CLOSE_REMAINING_MS = 2 * 60 * 1000;

/** Hard safety ceiling — realistically never hit; keeps a bad loop from running forever. */
export const FOLLOW_UP_SAFETY_CAP = 40;

/** Max interviewer turns in a slice review before wrap-up (includes opener). */
export const FOLLOW_UP_SLICE_SAFETY_CAP = 6;

/** From this many prior interviewer turns in the slice, warn against new questions. */
export const FOLLOW_UP_SLICE_SOFT_WARN_AT = 4;

/** From this count, the model should prefer wrap-up over a new question. */
export const FOLLOW_UP_SLICE_LAST_QUESTION_AT = 5;
