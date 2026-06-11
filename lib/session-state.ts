// SessionState is app-owned. The agent never mutates it directly — tools request, app validates and commits.
// chatHistory is intentionally NOT here — it travels separately on the request and is sent to the model in full.
// roundStartTime and phaseStartTime are intentionally NOT here — they live in InterviewWorkspace state
// for elapsed-time reasoning. SessionState only carries what agent tools need.

import type { SessionPhase, TranscriptEntry } from "./chat";
import {
  questionToEditorInitialValue,
  type PublicFollowUp,
  type PublicQuestion,
  type Question,
} from "./questions";
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

/**
 * The follow-up variant the candidate is ACTIVELY working on. Durable across
 * turns (unlike codingEscalationHint, which exists only on the introduction
 * turn) so the model always knows which task the conversation is about — the
 * base question block in the system prompt would otherwise reassert itself
 * once the introduction scrolls out of recent history. The app owns the
 * lifecycle: set when the introduction turn is delivered, cleared when the
 * variant's segment wraps. `mode` is decided by the app from remaining time
 * at scheduling — the model never reads the clock to pick the format.
 * Carries only the candidate-facing prompt — never hidden test data.
 */
export type ActiveFollowUp = Readonly<{
  /** FollowUp.id — sent as followUpId on Run/Submit so grading targets this variant's test sets. */
  id: string;
  index: number;
  prompt: string;
  /** Graded entry function when the variant's contract differs from the baseline's (FollowUp.entryFunction). */
  entryFunction?: string;
  /** "code" = full mini-round (approach → implement → submit); "verbal" = discussion only. */
  mode: "code" | "verbal";
}>;

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
   * proactive coding-escalation turn. Carries the banked variant prompt so the
   * model delivers the escalation from state. Absent on normal turns; the app
   * owns the trigger condition and variant selection.
   */
  codingEscalationHint?: string;
  /**
   * Transient per-turn hint (NOT persisted): set only on the review turn that a
   * candidate Submit triggers. Carries the submit grade as aggregate counts plus
   * the human-readable DESCRIPTIONS of any failed hidden cases — never raw hidden
   * input/expected/actual — so the model can open the review (post-pass) or probe
   * the specific failed edge case by name. Absent on normal turns.
   */
  submitReviewHint?: string;
  /**
   * Transient per-turn hint (NOT persisted): set only on the app-fired turn
   * that OPENS the final Q&A segment. The app decides from remaining time
   * whether the opener asks substantive deeper questions or closes the
   * interview warmly; without it the model may wrap the segment on its very
   * first turn and feedback fires with no final questions asked.
   */
  finalFollowUpHint?: string;
  /** See ActiveFollowUp. null/absent while the baseline (original problem) is the task. */
  activeFollowUp?: ActiveFollowUp | null;
  question: Pick<
    Question,
    "id" | "title" | "difficulty" | "candidateDescription" | "testCases" | "entryFunction"
  > & {
    /**
     * Server-only — injected from the question bank inside /api/interviewer and
     * never supplied by the client (the browser only ever holds a
     * PublicQuestion). Optional on the wire; the route always fills it before
     * building the system prompt.
     */
    interviewerContext?: string;
    /** Follow-up variants with hidden test cases stripped (browser-safe). */
    followUps?: PublicFollowUp[];
  };
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

export function createSessionState(question: PublicQuestion): SessionState {
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
      testCases: question.testCases,
      entryFunction: question.entryFunction,
      followUps: question.followUps,
    },
  };
}

export function restoreSessionState(
  persisted: PersistedInterviewSession,
  question: PublicQuestion
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
      testCases: question.testCases,
      entryFunction: question.entryFunction,
      followUps: question.followUps,
    },
  };
}
