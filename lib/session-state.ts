// SessionState is app-owned. The agent never mutates it directly — tools request, app validates and commits.
// chatHistory and rollingSummary are intentionally NOT here — they live in per-request route state, not session.
// roundStartTime and phaseStartTime are intentionally NOT here — they live in InterviewWorkspace state
// for elapsed-time reasoning. SessionState only carries what agent tools need.

import type { SessionPhase, TranscriptEntry } from "./chat";
import { questionToEditorInitialValue, type Question } from "./questions";
import type { Snapshot } from "./snapshots";
// type-import only — adding value imports will create a cycle
import type { PersistedInterviewSession } from "./interview-session-storage";
import { ROUND_DURATION_MS } from "./interview-limits";

export type { SessionPhase };

// Persistence bridge: stored sessions keep TestResult[] from judge0.ts on
// PersistedInterviewSession. TestRunSummary is session-only; hidden case
// provenance is lost on reload (lossy bridge, accepted). Do not migrate
// persistence to TestRunSummary.
export type TestRunSummary = {
  visiblePassed: boolean;
  hiddenPassed: boolean;
  passedCount: number;
  failedCount: number;
  hiddenFailedCount: number;
  cases: Array<{
    input: string;
    expected: string;
    actual: string;
    passed: boolean;
    /** When true, input/expected must be redacted before returning to the model. */
    hidden: boolean;
  }>;
};

// questionId is the persistent identity — there is no separate sessionId.
// Persistence is keyed by questionId in interview-session-storage.ts.
export type SessionState = Readonly<{
  phase: SessionPhase;
  /** Always false from coding phase onward — never re-locked after that point. */
  editorLocked: boolean;
  /** null until coding phase starts. */
  roundEndsAt: number | null;
  /** Agent cannot exceed FOLLOW_UP_SAFETY_CAP from lib/interview-limits.ts. */
  followUpTurnsUsed: number;
  /** Agent cannot exceed TEST_RUNS_MAX from lib/interview-limits.ts. The run_tests tool must import and check this before executing. */
  testRunsUsed: number;
  lastTestResult: TestRunSummary | null;
  currentCode: string;
  snapshots: ReadonlyArray<Snapshot>;
  /**
   * Best-effort topic memory, shown to the model as context to avoid circular
   * questions. No longer mutated mid-session (the mark_topic_probed control tool
   * was removed); it is restored from persistence and reset on a new session.
   */
  topicsProbed: ReadonlyArray<string>;
  transcript: ReadonlyArray<TranscriptEntry>;
  /** Set during a forced verbal wrap-up transition — agent should ask for walkthrough. */
  forcedWrap?: boolean;
  /** "slice" if in the mid-coding slice segment, "final" if in the post-coding final segment. */
  followUpSegment?: "slice" | "final";
  /**
   * Transient per-turn hint (NOT persisted): set only when the app initiates a
   * proactive coding-escalation turn. Carries the banked/autonomous variant
   * prompt so the model delivers the escalation from state. Absent on normal
   * turns; the app owns the trigger condition and variant selection.
   */
  codingEscalationHint?: string;
  question: Pick<
    Question,
    | "id"
    | "title"
    | "difficulty"
    | "candidateDescription"
    | "interviewerContext"
    | "testCases"
    | "entryFunction"
    | "followUps"
  >;
}>;

// Grounding/execution tools only. There are no control-flow tools: phase is
// app metadata (advanced by InterviewWorkspace from inline tokens / UI / timers,
// never by the model), and follow-up/feedback are app-driven. Tools are NOT
// phase-gated — the model may read evidence or run tests in any phase.
export type ToolName =
  | "read_current_code"
  | "read_recent_transcript"
  | "get_test_results"
  | "run_tests";

export function createSessionState(question: Question): SessionState {
  return {
    phase: "clarifying",
    editorLocked: true,
    roundEndsAt: null,
    followUpTurnsUsed: 0,
    testRunsUsed: 0,
    lastTestResult: null,
    // Must match what the editor seeds (questionToEditorInitialValue) so the
    // read_current_code tool returns exactly what the candidate sees on turn 1.
    currentCode: questionToEditorInitialValue(question),
    snapshots: [],
    topicsProbed: [],
    transcript: [],
    question: {
      id: question.id,
      title: question.title,
      difficulty: question.difficulty,
      candidateDescription: question.candidateDescription,
      interviewerContext: question.interviewerContext,
      testCases: question.testCases,
      entryFunction: question.entryFunction,
      followUps: question.followUps,
    },
  };
}

export function restoreSessionState(
  persisted: PersistedInterviewSession,
  question: Question
): SessionState {
  return {
    phase: persisted.sessionPhase,
    // derived from phase, not persisted — never manually re-lock after coding phase
    editorLocked:
      persisted.sessionPhase === "clarifying" ||
      persisted.sessionPhase === "planning",
    roundEndsAt:
      persisted.roundStartTime != null
        ? persisted.roundStartTime + ROUND_DURATION_MS
        : null,
    followUpTurnsUsed: persisted.followUpsReachedCount,
    testRunsUsed: persisted.runCount,
    // Hidden pass/fail is irrecoverable from persisted TestResult[]; reporting
    // unknown (null) beats reporting a guessed false.
    lastTestResult: null,
    currentCode: persisted.code || question.starterCode,
    snapshots: persisted.snapshots,
    topicsProbed: persisted.topicsProbed,
    transcript: persisted.transcript,
    question: {
      id: question.id,
      title: question.title,
      difficulty: question.difficulty,
      candidateDescription: question.candidateDescription,
      interviewerContext: question.interviewerContext,
      testCases: question.testCases,
      entryFunction: question.entryFunction,
      followUps: question.followUps,
    },
  };
}
