export type SessionPhase =
  | "clarifying"
  | "planning"
  | "coding"
  | "followUp"
  | "feedback";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type TranscriptEntry = {
  text: string;
  timestamp: number;
};
