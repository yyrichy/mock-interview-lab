import type {
  ChatMessage,
  FollowUpSegment,
  SessionPhase,
  TranscriptEntry,
} from "@/lib/chat";
import type { TestResult } from "@/lib/judge0";
// type-import only — session-state type-imports this module back; a value
// import would create a runtime cycle.
import type { ActiveFollowUp } from "@/lib/session-state";
import type { Snapshot } from "@/lib/snapshots";

const STORAGE_VERSION = 1 as const;

export type PersistedInterviewSession = {
  version: typeof STORAGE_VERSION;
  questionId: string;
  savedAt: number;
  sessionPhase: SessionPhase;
  messages: ChatMessage[];
  code: string;
  transcript: TranscriptEntry[];
  roundStartTime: number | null;
  phaseStartTime: number | null;
  codingStartedAt: number | null;
  testResults: TestResult[] | null;
  testAllPassed: boolean | null;
  testRunError: string | null;
  runCount: number;
  traceContent: string;
  currentFollowUpIndex: number;
  followUpsReachedCount: number;
  followUpSegment: FollowUpSegment;
  followUpSealed: boolean;
  forcedWrap: boolean;
  roundTimedOut: boolean;
  /** The follow-up variant in progress at save time, so a reload mid-variant keeps task identity. */
  activeFollowUp: ActiveFollowUp | null;
  baselineSolvedAt: number | null;
  codingEscalationStep: number;
  bruteForceSkipped: boolean;
  snapshots: Snapshot[];
  /** Topics already probed by the interviewer; persisted to prevent circular questioning across reloads. */
  topicsProbed: string[];
};

export function sessionStorageKey(questionId: string): string {
  return `ai-interviewer:session:v1:${questionId}`;
}

function isSessionPhase(v: unknown): v is SessionPhase {
  return (
    v === "clarifying" ||
    v === "planning" ||
    v === "coding" ||
    v === "followUp" ||
    v === "feedback"
  );
}

function isFollowUpSegment(v: unknown): v is FollowUpSegment {
  return v === "slice" || v === "final";
}

function isChatMessage(v: unknown): v is ChatMessage {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    (o.role === "user" || o.role === "assistant") &&
    typeof o.content === "string"
  );
}

function isTranscriptEntry(v: unknown): v is TranscriptEntry {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return typeof o.text === "string" && typeof o.timestamp === "number";
}

function isTestResult(v: unknown): v is TestResult {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return (
    typeof o.input === "string" &&
    typeof o.expected === "string" &&
    typeof o.actual === "string" &&
    typeof o.passed === "boolean"
  );
}

function isActiveFollowUp(v: unknown): v is ActiveFollowUp {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.index === "number" &&
    typeof o.prompt === "string" &&
    (o.entryFunction === undefined || typeof o.entryFunction === "string") &&
    (o.mode === "code" || o.mode === "verbal")
  );
}

function isSnapshot(v: unknown): v is Snapshot {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return (
    typeof o.code === "string" &&
    typeof o.transcript === "string" &&
    typeof o.timestamp === "number"
  );
}

export function parsePersistedInterviewSession(
  raw: string,
  expectedQuestionId: string
): PersistedInterviewSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  if (o.version !== STORAGE_VERSION || o.questionId !== expectedQuestionId) {
    return null;
  }
  if (!isSessionPhase(o.sessionPhase)) {
    return null;
  }
  if (!Array.isArray(o.messages) || !o.messages.every(isChatMessage)) {
    return null;
  }
  if (typeof o.code !== "string") {
    return null;
  }
  if (!Array.isArray(o.transcript) || !o.transcript.every(isTranscriptEntry)) {
    return null;
  }
  if (!isFollowUpSegment(o.followUpSegment)) {
    return null;
  }
  const testResults =
    o.testResults === null
      ? null
      : Array.isArray(o.testResults) && o.testResults.every(isTestResult)
        ? o.testResults
        : null;
  if (o.testResults !== null && testResults === null) {
    return null;
  }
  const snapshots = Array.isArray(o.snapshots)
    ? o.snapshots.filter(isSnapshot)
    : [];
  const topicsProbed = Array.isArray(o.topicsProbed)
    ? o.topicsProbed.filter((v): v is string => typeof v === "string")
    : [];

  return {
    version: STORAGE_VERSION,
    questionId: expectedQuestionId,
    savedAt: typeof o.savedAt === "number" ? o.savedAt : Date.now(),
    sessionPhase: o.sessionPhase,
    messages: o.messages,
    code: o.code,
    transcript: o.transcript,
    roundStartTime:
      typeof o.roundStartTime === "number" ? o.roundStartTime : null,
    phaseStartTime:
      typeof o.phaseStartTime === "number" ? o.phaseStartTime : null,
    codingStartedAt:
      typeof o.codingStartedAt === "number" ? o.codingStartedAt : null,
    testResults,
    testAllPassed:
      typeof o.testAllPassed === "boolean" ? o.testAllPassed : null,
    testRunError:
      typeof o.testRunError === "string" ? o.testRunError : null,
    runCount: typeof o.runCount === "number" ? o.runCount : 0,
    traceContent: typeof o.traceContent === "string" ? o.traceContent : "",
    currentFollowUpIndex:
      typeof o.currentFollowUpIndex === "number" ? o.currentFollowUpIndex : 0,
    followUpsReachedCount:
      typeof o.followUpsReachedCount === "number" ? o.followUpsReachedCount : 0,
    followUpSegment: o.followUpSegment,
    followUpSealed: o.followUpSealed === true,
    forcedWrap: o.forcedWrap === true,
    roundTimedOut: o.roundTimedOut === true,
    activeFollowUp: isActiveFollowUp(o.activeFollowUp)
      ? o.activeFollowUp
      : null,
    baselineSolvedAt:
      typeof o.baselineSolvedAt === "number" ? o.baselineSolvedAt : null,
    codingEscalationStep:
      typeof o.codingEscalationStep === "number" ? o.codingEscalationStep : 0,
    bruteForceSkipped: o.bruteForceSkipped === true,
    snapshots,
    topicsProbed,
  };
}

export function loadPersistedInterviewSession(
  questionId: string
): PersistedInterviewSession | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = localStorage.getItem(sessionStorageKey(questionId));
    if (!raw) {
      return null;
    }
    return parsePersistedInterviewSession(raw, questionId);
  } catch {
    return null;
  }
}

export function savePersistedInterviewSession(
  session: PersistedInterviewSession
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    localStorage.setItem(
      sessionStorageKey(session.questionId),
      JSON.stringify(session)
    );
  } catch {
    /* quota / private mode */
  }
}

export function clearPersistedInterviewSession(questionId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    localStorage.removeItem(sessionStorageKey(questionId));
    localStorage.removeItem(`ai-interviewer:code:${questionId}`);
  } catch {
    /* ignore */
  }
}
