import type { SessionPhase } from "@/lib/chat";

export type InterviewerStyle =
  | "surprise-me"
  | "depth"
  | "pace"
  | "behavioral"
  | "craft";

export type ConcreteInterviewerStyle = Exclude<InterviewerStyle, "surprise-me">;

export const INTERVIEWER_STYLE_STORAGE_KEY = "ai-interviewer:interviewerStyle";
export const DEFAULT_INTERVIEWER_STYLE: InterviewerStyle = "surprise-me";

export const INTERVIEWER_STYLE_OPTIONS: { id: InterviewerStyle; label: string }[] = [
  { id: "surprise-me", label: "Surprise me" },
  { id: "depth", label: "Depth & Verification" },
  { id: "pace", label: "Pace & Momentum" },
  { id: "behavioral", label: "Behavioral" },
  { id: "craft", label: "Craft & Modularity" },
];

const CONCRETE_STYLES: ConcreteInterviewerStyle[] = [
  "depth",
  "pace",
  "behavioral",
  "craft",
];

export function pickRandomConcreteStyle(): ConcreteInterviewerStyle {
  return CONCRETE_STYLES[Math.floor(Math.random() * CONCRETE_STYLES.length)];
}

export function isInterviewerStyle(v: unknown): v is InterviewerStyle {
  return (
    v === "surprise-me" ||
    v === "depth" ||
    v === "pace" ||
    v === "behavioral" ||
    v === "craft"
  );
}

export function isConcreteInterviewerStyle(
  v: unknown
): v is ConcreteInterviewerStyle {
  return (
    v === "depth" ||
    v === "pace" ||
    v === "behavioral" ||
    v === "craft"
  );
}

const STYLE_FRAGMENTS: Record<
  ConcreteInterviewerStyle,
  Partial<Record<SessionPhase, string>>
> = {
  "depth": {
    clarifying:
      "[Style: Be precise about constraints. If they skip an important edge case in their clarifying questions, surface it with a pointed follow-up.]",
    planning:
      "[Style: Push hard on correctness and optimality before approving the plan. Probe time and space complexity explicitly. Ask whether the approach handles the worst-case input.]",
    coding:
      "[Style: Hold back on hints. If stuck, prefer asking 'what does your current approach miss?' over giving a direct nudge.]",
    followUp:
      "[Style: Prioritize verification — edge cases, invariant checks, worst-case performance. Ask them to trace through a tricky input before accepting their final complexity claim.]",
  },
  "pace": {
    clarifying:
      "[Style: Keep it moving. Limit clarifications to one or two key questions. If they over-analyze the statement, gently redirect toward thinking about an approach.]",
    planning:
      "[Style: Favor momentum over perfection. Acknowledge a reasonable plan quickly and push toward implementation. Be ready to suggest a follow-on variant if time allows after the first is solved.]",
    coding:
      "[Style: Short, crisp nudges only. Avoid long back-and-forth; keep the candidate writing code.]",
    followUp:
      "[Style: Move fast. One tight question per turn; if the answer is solid, wrap up rather than dwelling.]",
  },
  "behavioral": {
    clarifying:
      "[Style: Normal clarification flow.]",
    planning:
      "[Style: At a natural pause in the approach discussion, weave in one brief behavioral question — e.g. 'Have you worked on something like this before, and what was the tricky part at scale?' or 'How would you explain this tradeoff to a non-technical stakeholder?' Keep it short; return to the technical plan immediately after. Do this once and only once.]",
    coding:
      "[Style: Normal coding guidance.]",
    followUp:
      "[Style: If there is a natural moment, briefly note whether the candidate communicated their reasoning clearly — frame as a minor observation, not a deep dive.]",
  },
  "craft": {
    clarifying:
      "[Style: Normal clarification flow.]",
    planning:
      "[Style: In addition to algorithm and complexity, ask one pointed question about naming and structure — e.g. 'What would you name the key helper here, and how would you divide responsibilities across functions?']",
    coding:
      "[Style: Notice naming and modularity as they code. A brief 'would you rename that?' or 'nice — that's clean' is enough to signal the focus.]",
    followUp:
      "[Style: Weight naming and code structure alongside correctness. Ask what the candidate would refactor first in a real code review.]",
  },
};

export function getStyleFragment(
  style: ConcreteInterviewerStyle,
  phase: SessionPhase
): string {
  return STYLE_FRAGMENTS[style][phase] ?? "";
}

export function styleDisplayName(style: ConcreteInterviewerStyle): string {
  const map: Record<ConcreteInterviewerStyle, string> = {
    "depth": "Depth & Verification",
    "pace": "Pace & Momentum",
    "behavioral": "Behavioral",
    "craft": "Craft & Modularity",
  };
  return map[style];
}
