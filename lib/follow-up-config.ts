/** Timing constants for the follow-up phase auto-close threshold and per-slice turn limits. */

/** Auto-close the follow-up segment when remaining round time drops at or below this. */
export const FOLLOW_UP_AUTO_CLOSE_REMAINING_MS = 2 * 60 * 1000;

/**
 * Max interviewer turns in a slice (post-Submit) review before the app FORCES the
 * segment to advance — includes the opener. A passing review is meant to be a brief
 * ack + ONE focused probe, then the wrap, so this is intentionally low: it is the
 * weak-caller backstop for a model that keeps probing and never emits
 * [segment-complete]. The forced advance fires in InterviewWorkspace's
 * sendUserMessage finally (turns >= cap) and routes through the SAME deterministic
 * advanceAfterSegmentComplete the token would have triggered, so the review can
 * never stall in an endless probe ladder. Allows opener (ack + probe 1) + one
 * follow-up turn before forcing — enough for "1 ack + 2 probes", no more.
 */
export const FOLLOW_UP_SLICE_SAFETY_CAP = 3;
