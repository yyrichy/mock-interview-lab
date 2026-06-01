export type SessionPhase =
  | "clarifying"
  | "planning"
  | "coding"
  | "followUp"
  | "feedback";

/**
 * Follow-up segment within the `followUp` phase. `slice` = mid-coding review of
 * the implementation just passed; `final` = end-of-round verbal Q&A.
 */
export type FollowUpSegment = "slice" | "final";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type TranscriptEntry = {
  text: string;
  timestamp: number;
};
