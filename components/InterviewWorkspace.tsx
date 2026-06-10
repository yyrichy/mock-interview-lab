"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useCodingShortcuts } from "@/lib/hooks/useCodingShortcuts";
import { useInterviewSessionAutosave } from "@/lib/hooks/useInterviewSessionAutosave";
import { useFocusMicRecorder } from "@/lib/hooks/useFocusMicRecorder";
import { useGroqAmbient } from "@/lib/hooks/useGroqAmbient";
import { usePersistedState } from "@/lib/hooks/usePersistedState";
import { useTickInterval } from "@/lib/hooks/useTickInterval";
import { ChatPanel } from "@/components/ChatPanel";
import { ChatToggleButton } from "@/components/ChatToggleButton";
import { Editor } from "@/components/Editor";
import { ResizableTestResultsSection } from "@/components/ResizableTestResultsSection";
import {
  streamFeedbackApi,
  streamInterviewerApi,
  type InterviewerDataEvent,
} from "@/lib/ai-client";
import type { SessionState, TestRunSummary } from "@/lib/session-state";
import {
  AI_MODEL_PRESET_STORAGE_KEY,
  DEFAULT_AI_MODEL_PRESET_ID,
  DEFAULT_UTILITY_MODEL_PRESET_ID,
  UTILITY_MODEL_PRESET_STORAGE_KEY,
  isAiModelPresetId,
  type AiModelPresetId,
} from "@/lib/ai-models";
import type {
  ChatMessage,
  SessionPhase,
  TranscriptEntry,
} from "@/lib/chat";
import {
  clearPersistedInterviewSession,
  loadPersistedInterviewSession,
  savePersistedInterviewSession,
  type PersistedInterviewSession,
} from "@/lib/interview-session-storage";
import {
  getSampledFeedbackSnapshots,
  getSnapshots,
  replaceSnapshots,
  startSnapshots,
  stopSnapshots,
} from "@/lib/snapshots";
import {
  isMediaRecorderCaptureSupported,
  transcribeWithGroqWhisper,
} from "@/lib/speech";
import type { TestResult, RunCodeResult } from "@/lib/judge0";
import {
  FOLLOW_UP_AUTO_CLOSE_REMAINING_MS,
  FOLLOW_UP_SLICE_SAFETY_CAP,
} from "@/lib/follow-up-config";
import {
  FOLLOW_UP_SAFETY_CAP,
  ROUND_DURATION_MS,
  TEST_RUNS_MAX,
} from "@/lib/interview-limits";
import type { FollowUpSegment } from "@/lib/chat";
import type { PaceReport } from "@/lib/feedback";
import { PHASE_BUDGET_MS } from "@/lib/phase-config";
import { getRoundThresholds } from "@/lib/round-config";
import {
  questionToEditorInitialValue,
  questionToProblemStatement,
  type PublicQuestion,
} from "@/lib/questions";
import { assistantInvitesCodingWithoutToken } from "@/lib/planning-coding-invite";
import { buildCodingVoiceReport } from "@/lib/coding-voice-report";
import {
  buildBankedEscalationHint,
  buildSubmitReviewHint,
  getPendingBankedFollowUp,
} from "@/lib/coding-escalation";

type Props = {
  question: PublicQuestion;
};

function formatElapsedMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

const ROUND_THRESHOLDS = getRoundThresholds(ROUND_DURATION_MS);

function phaseLabel(phase: SessionPhase): string {
  switch (phase) {
    case "clarifying":
      return "Clarifying";
    case "planning":
      return "Planning";
    case "coding":
      return "Coding";
    case "followUp":
      return "Follow-ups";
    case "feedback":
      return "Feedback";
  }
}

function formatTranscriptLog(entries: TranscriptEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  return entries
    .map(
      (e) => `[${new Date(e.timestamp).toISOString()}] ${e.text}`
    )
    .join("\n");
}

// Inline completion signal the model emits when it has finished a review or
// follow-up segment (mirrors the [->planning]/[->coding] phase tokens). The app
// strips it from the displayed reply and advances the interview from state — the
// model never picks the destination.
const SEGMENT_DONE_TOKEN = "[segment-complete]";

function stripSegmentDone(text: string): { cleaned: string; found: boolean } {
  if (!text.includes(SEGMENT_DONE_TOKEN)) {
    return { cleaned: text, found: false };
  }
  const cleaned = text
    .split(SEGMENT_DONE_TOKEN)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleaned, found: true };
}

// True when a reply still ends on a question to the candidate. Used to hold the
// slice-review advance: an over-eager caller sometimes appends [segment-complete]
// to the SAME turn it asks its one focused review question. We honor the question
// (wait for the reply) instead of skipping the candidate past it.
function endsWithQuestion(text: string): boolean {
  return /\?["')\]]*\s*$/.test(text.trim());
}

// The question-hold guard only applies to the slice (post-Submit) review. Routed
// through a helper so the full FollowUpSegment union is preserved at call sites
// where flow analysis has narrowed the ref to a single literal.
function isSliceReview(segment: FollowUpSegment): boolean {
  return segment === "slice";
}

// Identity of a submitted solution, for idempotent Submit. Strips per-line
// trailing whitespace and any trailing blank lines so a no-op edit (stray space,
// extra newline) does not count as a change. Leading/interior content is left
// untouched — Python indentation matters and any real logic edit must register.
function normalizeSubmittedCode(code: string): string {
  return code.replace(/[ \t]+$/gm, "").replace(/\s+$/, "");
}

type SessionBoot = "pending" | "ready";

export function InterviewWorkspace({ question }: Props) {
  const [sessionBoot, setSessionBoot] = useState<SessionBoot>("pending");
  /** When false, localStorage session snapshots are not written (cleared after feedback). */
  const [sessionPersistenceActive, setSessionPersistenceActive] =
    useState(true);
  /** True after reload restored a saved session; cleared on Reset session. */
  const restoredSessionRef = useRef(false);
  const roundTimeoutFeedbackPendingRef = useRef(false);
  const runFinalFeedbackRef = useRef<() => void>(() => {});
  const collectSessionRef = useRef<() => PersistedInterviewSession>(() => ({
    version: 1,
    questionId: question.id,
    savedAt: Date.now(),
    sessionPhase: "clarifying",
    messages: [],
    code: questionToEditorInitialValue(question),
    transcript: [],
    roundStartTime: null,
    phaseStartTime: null,
    codingStartedAt: null,
    testResults: null,
    testAllPassed: null,
    testRunError: null,
    runCount: 0,
    traceContent: "",
    currentFollowUpIndex: 0,
    followUpsReachedCount: 0,
    followUpSegment: "final",
    followUpSealed: false,
    forcedWrap: false,
    roundTimedOut: false,
    rollingContext: null,
    baselineSolvedAt: null,
    codingEscalationStep: 0,
    bruteForceSkipped: false,
    snapshots: [],
    topicsProbed: [],
  }));

  const [chatOpen, setChatOpen] = useState(true);
  const [sessionPhase, setSessionPhase] =
    useState<SessionPhase>("clarifying");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  // Id of the assistant bubble for the single in-flight stream. Only this
  // bubble shows "Alex is thinking" — prevents old empty bubbles from all
  // appearing live when any stream is active.
  const [streamingAssistantId, setStreamingAssistantId] = useState<
    string | null
  >(null);
  const streamingAssistantIdRef = useRef<string | null>(null);
  // Set when a streaming turn emitted [segment-complete]; the deferred advance
  // runs once that stream finishes (see isStreaming effect) so isStreamingRef has
  // settled before the next turn starts.
  const pendingSegmentAdvanceRef = useRef(false);
  // Counts-only submit grade (+ failed-hidden descriptions) for the review turn a
  // Submit triggers. Transient — consumed by enterSubmitReview, never persisted.
  const pendingSubmitHintRef = useRef<string | null>(null);
  // Idempotent Submit: normalized code of the last submission and its counts-only
  // outcome label. A re-submit of unchanged code re-shows the outcome and fires
  // NO new review turn. Reset to null when a new variant's coding begins so the
  // first submit of each variant always reviews.
  const lastSubmittedCodeRef = useRef<string | null>(null);
  const lastSubmitOutcomeRef = useRef<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [liveCaption, setLiveCaption] = useState("");
  const [speechError, setSpeechError] = useState<string | null>(null);
  const focusMic = useFocusMicRecorder();
  const whisperTranscribing = focusMic.transcribing;
  const [testRunLoading, setTestRunLoading] = useState(false);
  const [testRunError, setTestRunError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<TestResult[] | null>(null);
  const [testAllPassed, setTestAllPassed] = useState<boolean | null>(null);
  /** Counts-only banner after a Submit (e.g. "visible 7/7, hidden 5/7"). No hidden I/O. */
  const [submitOutcome, setSubmitOutcome] = useState<string | null>(null);
  const lastTestResultRef = useRef<TestRunSummary | null>(null);
  const [runMode, setRunMode] = usePersistedState<"standard" | "limited" | "dry-run">(
    "ai-interviewer:runMode",
    "standard",
    (raw) =>
      raw === "standard" || raw === "limited" || raw === "dry-run" ? raw : null
  );
  const [runCount, setRunCount] = useState(0);
  const runCountRef = useRef(0);
  const [traceContent, setTraceContent] = useState("");
  const [sessionResetKey, setSessionResetKey] = useState(0);
  const [codingStartedAt, setCodingStartedAt] = useState<number | null>(null);
  const [roundStartTime, setRoundStartTime] = useState<number | null>(null);
  const roundStartTimeRef = useRef<number | null>(null);
  const roundTimedOutRef = useRef(false);
  const openingGenRef = useRef(0);
  const followUpGenRef = useRef(0);
  const followUpAssistantTurnsRef = useRef(0);
  const followUpSealedRef = useRef(false);
  const [followUpSealed, setFollowUpSealed] = useState(false);
  const [followUpSegment, setFollowUpSegment] =
    useState<FollowUpSegment>("final");
  const followUpSegmentRef = useRef<FollowUpSegment>("final");
  /** Slice cap hit: allow one candidate reply (or proceed button) before sealing chat. */
  const sliceAwaitingCandidateReplyRef = useRef(false);
  const sliceForceWrapUpRef = useRef(false);
  const [sliceGraceReply, setSliceGraceReply] = useState(false);
  const [modelPresetId, setModelPresetId] = usePersistedState<AiModelPresetId>(
    AI_MODEL_PRESET_STORAGE_KEY,
    DEFAULT_AI_MODEL_PRESET_ID,
    (raw) => (isAiModelPresetId(raw) ? raw : null)
  );
  const modelPresetIdRef = useRef(modelPresetId);
  const [utilityModelPresetId, setUtilityModelPresetId] =
    usePersistedState<AiModelPresetId>(
      UTILITY_MODEL_PRESET_STORAGE_KEY,
      DEFAULT_UTILITY_MODEL_PRESET_ID,
      (raw) => (isAiModelPresetId(raw) ? raw : null)
    );
  const sessionPhaseRef = useRef<SessionPhase>(sessionPhase);
  const isStreamingRef = useRef(isStreaming);
  const focusedMicRef = useRef(false);
  /** True while the user is pressing the mic (all phases). */
  const focusMicHeldRef = useRef(false);
  const pauseBgForAiRef = useRef(false);
  /** Aborts any in-flight AI stream when the component unmounts. */
  const streamAbortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const testRunLoadingRef = useRef(false);
  const handleRunTestsRef = useRef(() => {});
  const handleSubmitRef = useRef(() => {});
  const rollingContextRef = useRef<string | null>(null);
  // Set before each agent stream begins so the shared onData handler
  // (handleAgentDataEvent) can append error events to the currently-streaming
  // assistant bubble across all migrated call sites.
  const currentAgentAssistantIdRef = useRef<string | null>(null);
  const [padRealism, setPadRealism] = usePersistedState<boolean>(
    "ai-interviewer:padRealism",
    false,
    (raw) => (raw === "true" ? true : raw === "false" ? false : null),
    (v) => (v ? "true" : "false")
  );
  const [humanLatency, setHumanLatency] = usePersistedState<boolean>(
    "ai-interviewer:humanLatency",
    false,
    (raw) => (raw === "true" ? true : raw === "false" ? false : null),
    (v) => (v ? "true" : "false")
  );
  // Set once the candidate's baseline passes both visible and hidden on a Submit.
  // Drives whether banked variants are introduced. Ref-only (no render reads it).
  const baselineSolvedAtRef = useRef<number | null>(null);
  const codingEscalationStepRef = useRef(0);
  const escalationNudgeGenRef = useRef(0);
  // Cutoff for the ambient-tail merge: every typed/voice user message includes
  // ambient transcript captured AFTER this timestamp (and within a short window),
  // then advances the cutoff so the same lines aren't sent twice.
  const lastSentAmbientCutoffRef = useRef<number>(0);
  // When tests pass during coding, we drain queued HINT(s) into here and the
  // proactive nudge runner consumes them. Treated as a single bundled HINT.
  const pendingProactiveEscalationHintRef = useRef<string | null>(null);
  // True when the queued proactive nudge is introducing a banked variant (drives
  // the follow-up-count increment on success).
  const pendingProactiveBankedRef = useRef(false);
  // Index to commit as currentFollowUpIndex once the queued banked variant is
  // actually DELIVERED (its nudge stream completes). Committing at delivery —
  // not at scheduling — means a failed or guard-skipped nudge leaves the
  // variant pending, so the next advance retries it instead of silently
  // burning it and skipping to final Q&A.
  const pendingProactiveBankedNextIndexRef = useRef<number | null>(null);
  const [forcedWrap, setForcedWrap] = useState(false);
  const forcedWrapRef = useRef(false);
  const forcedWrapHintPendingRef = useRef(false);
  const forcedHandoffScheduledRef = useRef(false);
  const forcedWrapOpenerGenRef = useRef(0);
  const [currentFollowUpIndex, setCurrentFollowUpIndex] = useState(0);
  const currentFollowUpIndexRef = useRef(0);
  const [followUpsReachedCount, setFollowUpsReachedCount] = useState(0);
  const followUpsReachedCountRef = useRef(0);
  const [topicsProbed, setTopicsProbed] = useState<string[]>([]);
  const topicsProbedRef = useRef<string[]>([]);
  const [phaseStartTime, setPhaseStartTime] = useState<number | null>(null);
  const phaseStartTimeRef = useRef<number | null>(null);
  const phaseBudgetNudgedRef = useRef<Partial<Record<SessionPhase, boolean>>>({});
  const bruteForceSkippedRef = useRef(false);
  const firstTestRunConsumedRef = useRef(false);
  const followUpAutoCloseByTimeCheckedRef = useRef(false);

  const roundNowTick = useTickInterval(roundStartTime !== null, 1000);
  const codingNowTick = useTickInterval(
    sessionPhase === "coding" && codingStartedAt !== null,
    1000
  );

  const speechSupported = useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return isMediaRecorderCaptureSupported();
  }, []);

  const defaultInitialValue = questionToEditorInitialValue(question);
  const codeRef = useRef(defaultInitialValue);
  const [editorInitialCode, setEditorInitialCode] = useState(defaultInitialValue);
  const problemStatement = questionToProblemStatement(question);

  useEffect(() => {
    const saved = loadPersistedInterviewSession(question.id);
    if (saved) {
      restoredSessionRef.current = true;
      setMessages(saved.messages);
      setSessionPhase(saved.sessionPhase);
      setTranscript(saved.transcript);
      transcriptRef.current = saved.transcript;
      setRoundStartTime(saved.roundStartTime);
      roundStartTimeRef.current = saved.roundStartTime;
      setPhaseStartTime(saved.phaseStartTime);
      phaseStartTimeRef.current = saved.phaseStartTime;
      setCodingStartedAt(saved.codingStartedAt);
      setTestResults(saved.testResults);
      setTestAllPassed(saved.testAllPassed);
      setTestRunError(saved.testRunError);
      setRunCount(saved.runCount);
      runCountRef.current = saved.runCount;
      setTraceContent(saved.traceContent);
      setCurrentFollowUpIndex(saved.currentFollowUpIndex);
      currentFollowUpIndexRef.current = saved.currentFollowUpIndex;
      setFollowUpsReachedCount(saved.followUpsReachedCount);
      followUpsReachedCountRef.current = saved.followUpsReachedCount;
      setTopicsProbed(saved.topicsProbed);
      topicsProbedRef.current = saved.topicsProbed;
      setFollowUpSegment(saved.followUpSegment);
      followUpSegmentRef.current = saved.followUpSegment;
      setFollowUpSealed(saved.followUpSealed);
      followUpSealedRef.current = saved.followUpSealed;
      setForcedWrap(saved.forcedWrap);
      forcedWrapRef.current = saved.forcedWrap;
      if (saved.forcedWrap && saved.sessionPhase === "coding") {
        setSessionPhase("followUp");
        sessionPhaseRef.current = "followUp";
        setFollowUpSegment("final");
        followUpSegmentRef.current = "final";
      }
      roundTimedOutRef.current = saved.roundTimedOut;
      rollingContextRef.current = saved.rollingContext;
      baselineSolvedAtRef.current = saved.baselineSolvedAt;
      codingEscalationStepRef.current = saved.codingEscalationStep;
      bruteForceSkippedRef.current = saved.bruteForceSkipped;
      codeRef.current = saved.code;
      setEditorInitialCode(saved.code);
      sessionPhaseRef.current = saved.sessionPhase;
      if (saved.snapshots.length > 0) {
        replaceSnapshots(saved.snapshots);
      }
      if (
        saved.sessionPhase === "coding" &&
        !saved.forcedWrap &&
        !saved.roundTimedOut &&
        saved.codingStartedAt !== null
      ) {
        startSnapshots(
          () => codeRef.current,
          () => formatTranscriptLog(transcriptRef.current)
        );
      }
      if (saved.roundStartTime !== null) {
        const remaining =
          ROUND_DURATION_MS - (Date.now() - saved.roundStartTime);
        if (remaining <= 0 && saved.sessionPhase !== "feedback") {
          roundTimedOutRef.current = true;
          queueMicrotask(() => runFinalFeedbackRef.current());
        }
      }
    }
    setSessionBoot("ready");
  }, [question.id]);

  useInterviewSessionAutosave(
    sessionBoot === "ready" &&
      roundStartTime !== null &&
      sessionPersistenceActive,
    collectSessionRef
  );

  useEffect(() => {
    collectSessionRef.current = () => ({
      version: 1,
      questionId: question.id,
      savedAt: Date.now(),
      sessionPhase: sessionPhaseRef.current,
      messages,
      code: codeRef.current,
      transcript: transcriptRef.current,
      roundStartTime: roundStartTimeRef.current,
      phaseStartTime: phaseStartTimeRef.current,
      codingStartedAt,
      testResults,
      testAllPassed,
      testRunError,
      runCount: runCountRef.current,
      traceContent,
      currentFollowUpIndex: currentFollowUpIndexRef.current,
      followUpsReachedCount: followUpsReachedCountRef.current,
      followUpSegment: followUpSegmentRef.current,
      followUpSealed: followUpSealedRef.current,
      forcedWrap: forcedWrapRef.current,
      roundTimedOut: roundTimedOutRef.current,
      rollingContext: rollingContextRef.current,
      baselineSolvedAt: baselineSolvedAtRef.current,
      codingEscalationStep: codingEscalationStepRef.current,
      bruteForceSkipped: bruteForceSkippedRef.current,
      snapshots: getSnapshots(),
      topicsProbed: topicsProbedRef.current,
    });
  });

  useEffect(() => {
    if (
      sessionBoot !== "ready" ||
      roundStartTime === null ||
      !sessionPersistenceActive
    ) {
      return;
    }
    try {
      savePersistedInterviewSession(collectSessionRef.current());
    } catch {
      /* ignore */
    }
  }, [
    sessionBoot,
    sessionPersistenceActive,
    sessionPhase,
    messages,
    roundStartTime,
    codingStartedAt,
    testResults,
    testAllPassed,
    testRunError,
    runCount,
    traceContent,
    followUpSealed,
    followUpSegment,
    forcedWrap,
    topicsProbed,
    question.id,
  ]);

  useEffect(() => {
    sessionPhaseRef.current = sessionPhase;
  }, [sessionPhase]);

  useEffect(() => {
    modelPresetIdRef.current = modelPresetId;
  }, [modelPresetId]);

  useEffect(() => {
    runCountRef.current = runCount;
  }, [runCount]);

  useEffect(() => {
    currentFollowUpIndexRef.current = currentFollowUpIndex;
  }, [currentFollowUpIndex]);

  useEffect(() => {
    followUpsReachedCountRef.current = followUpsReachedCount;
  }, [followUpsReachedCount]);

  useEffect(() => {
    topicsProbedRef.current = topicsProbed;
  }, [topicsProbed]);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Deferred segment advance: a streaming turn that emitted [segment-complete]
  // sets pendingSegmentAdvanceRef; the actual advance runs once the stream fully
  // ends so isStreamingRef has settled before the next turn starts. This is also
  // the path the slice safety-cap backstop uses to force the segment forward.
  useEffect(() => {
    if (!isStreaming && pendingSegmentAdvanceRef.current) {
      pendingSegmentAdvanceRef.current = false;
      advanceAfterSegmentComplete();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useEffect(() => {
    setTranscript([]);
    lastTestResultRef.current = null;
    setTestResults(null);
    setTestAllPassed(null);
    setTestRunError(null);
    setTestRunLoading(false);
    setCodingStartedAt(null);
  }, [question.id]);

  useEffect(() => {
    testRunLoadingRef.current = testRunLoading;
  }, [testRunLoading]);

  useEffect(() => {
    roundStartTimeRef.current = roundStartTime;
  }, [roundStartTime]);

  useEffect(() => {
    phaseStartTimeRef.current = phaseStartTime;
  }, [phaseStartTime]);

  useEffect(() => {
    if (roundStartTime === null) return;
    const remaining = ROUND_DURATION_MS - (roundNowTick - roundStartTime);
    const phase = sessionPhaseRef.current;

    // Forced verbal wrap-up: move into follow-up and ask for a final approach
    // walkthrough (editor already locked in followUp). Fires exactly once.
    if (
      phase === "coding" &&
      !forcedWrapRef.current &&
      remaining > 0 &&
      remaining <= ROUND_THRESHOLDS.forcedStopTriggerMs
    ) {
      beginForcedVerbalWrapTransition();
      queueMicrotask(() => {
        void runForcedWrapOpener();
      });
    }

    // Hard floor: never enter follow-up with less than the floor reserved.
    // Precedence: this beats the verbal wrap trigger — hand off immediately into
    // the forced verbal wrap (not a fresh Submit/review, which would burn time).
    if (
      phase === "coding" &&
      !forcedHandoffScheduledRef.current &&
      remaining > 0 &&
      remaining <= ROUND_THRESHOLDS.followUpFloorMs
    ) {
      forcedHandoffScheduledRef.current = true;
      queueMicrotask(() => {
        if (sessionPhaseRef.current !== "coding" || forcedWrapRef.current) {
          return;
        }
        beginForcedVerbalWrapTransition();
        void runForcedWrapOpener();
      });
    }

    if (remaining <= 0 && !roundTimedOutRef.current) {
      roundTimedOutRef.current = true;
      stopSnapshots();
      groqAmbientRef.current?.stop();
      queueMicrotask(() => runFinalFeedbackRef.current());
    }

    // Backstop: if the round has ended + a grace period and we are still in
    // followUp, force feedback. Feedback is app-driven (Continue button or this
    // round-clock backstop); the model never triggers it.
    const FEEDBACK_BACKSTOP_GRACE_MS = 60_000; // 60s after round end
    if (
      roundTimedOutRef.current &&
      sessionPhaseRef.current === "followUp" &&
      !isStreamingRef.current
    ) {
      const overMs =
        roundStartTime !== null
          ? roundNowTick - (roundStartTime + ROUND_DURATION_MS)
          : 0;
      if (overMs >= FEEDBACK_BACKSTOP_GRACE_MS) {
        queueMicrotask(() => runFinalFeedbackRef.current());
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundNowTick, roundStartTime]);

  // If a stream was in progress when forced-wrap fired, retry the opener
  // as soon as that stream finishes.
  useEffect(() => {
    if (
      !isStreaming &&
      forcedWrapRef.current &&
      sessionPhaseRef.current === "followUp" &&
      !forcedWrapHintPendingRef.current
    ) {
      queueMicrotask(() => {
        void runForcedWrapOpener();
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

  useEffect(() => {
    if (sessionPhase !== "coding") {
      setLiveCaption("");
    }
  }, [sessionPhase]);

  // Cancel any in-flight AI stream on unmount so the server stops streaming
  // into a dead connection (resource + cost hygiene).
  useEffect(() => {
    const controller = new AbortController();
    streamAbortRef.current = controller;
    return () => {
      controller.abort();
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (sessionBoot !== "ready") {
      return;
    }
    if (restoredSessionRef.current) {
      return;
    }
    const myGen = ++openingGenRef.current;
    const assistantId = crypto.randomUUID();

    setMessages([{ id: assistantId, role: "assistant", content: "" }]);
    markStreamStart(assistantId);

    // Round + phase timer begin the moment the interviewer starts talking.
    const t0 = Date.now();
    roundStartTimeRef.current = t0;
    setRoundStartTime(t0);
    phaseStartTimeRef.current = t0;
    setPhaseStartTime(t0);
    phaseBudgetNudgedRef.current = {};

    async function runOpening() {
      currentAgentAssistantIdRef.current = assistantId;
      try {
        for await (const chunk of streamInterviewerApi(
          {
            sessionState: buildCurrentSessionState(),
            messages: [],
            rollingSummary: "",
            transcript: transcriptRef.current,
            turnCount: 0,
            modelPresetId: modelPresetIdRef.current,
          },
          (e) => handleAgentDataEvent(e, assistantId),
          streamAbortRef.current?.signal
        )) {
          if (myGen !== openingGenRef.current) {
            return;
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + chunk } : m
            )
          );
        }
      } catch (e) {
        if (myGen !== openingGenRef.current) {
          return;
        }
        const errText = e instanceof Error ? e.message : String(e);
        appendErrorToMessage(assistantId, errText);
      } finally {
        if (myGen === openingGenRef.current) {
          setIsStreaming(false);
          clearStreamingId(assistantId);
          finalizeAssistantMessage(assistantId);
        }
      }
    }

    void runOpening();

    return () => {
      openingGenRef.current++;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sessionBoot,
    question.id,
    sessionResetKey,
    question.candidateDescription,
  ]);

  useEffect(() => {
    if (!isStreaming && roundTimeoutFeedbackPendingRef.current) {
      roundTimeoutFeedbackPendingRef.current = false;
      void runFinalFeedbackStream();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

  // Groq Whisper ambient recording — runs during coding phase only.
  const groqAmbientRef = useGroqAmbient(
    sessionPhase === "coding",
    (text) =>
      setTranscript((prev) => [...prev, { text, timestamp: Date.now() }]),
    (error) => setSpeechError(error)
  );

  const editorLocked =
    sessionPhase === "clarifying" ||
    sessionPhase === "planning" ||
    sessionPhase === "feedback";
  const showEditorTools =
    sessionPhase === "coding" || sessionPhase === "followUp";

  function appendErrorToMessage(id: string, errText: string): void {
    const errorTail = `[Error: ${errText}]`;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id && !m.content.includes(errorTail)
          ? {
              ...m,
              content: m.content ? `${m.content}\n\n${errorTail}` : errorTail,
            }
          : m
      )
    );
  }

  /** Marks the start of a stream: sets the active bubble + streaming flag. */
  function markStreamStart(assistantId: string): void {
    streamingAssistantIdRef.current = assistantId;
    setStreamingAssistantId(assistantId);
    setIsStreaming(true);
  }

  /** Clears the streaming indicator only if this stream is still the active one. */
  function clearStreamingId(assistantId: string): void {
    if (streamingAssistantIdRef.current === assistantId) {
      streamingAssistantIdRef.current = null;
      setStreamingAssistantId(null);
    }
  }

  /**
   * Called in a stream's finally block: if the assistant bubble is still empty
   * (no text and no error was appended), give it a visible fallback so the user
   * never sees a silent blank bubble after a completed stream.
   */
  function finalizeAssistantMessage(assistantId: string): void {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId &&
        m.role === "assistant" &&
        m.content.trim() === ""
          ? {
              ...m,
              content:
                "[Alex didn't send a reply — try again or switch model.]",
            }
          : m
      )
    );
  }

  /**
   * Seam suppression: when a turn DELIBERATELY wrapped its segment (emitted
   * [segment-complete] and is advancing) but had nothing to say, its bubble is
   * empty after the token is stripped. That is NOT weak-caller silence — the model
   * intentionally closed the segment — so remove the stray empty bubble instead of
   * sealing it with the "didn't send a reply" fallback. This keeps the
   * final→feedback handoff (and the slice→final / variant-skip seams) clean:
   * feedback / the next segment opens directly after the real wrap, with no empty
   * interviewer turn between. A bubble that has prose is left untouched.
   */
  function dropEmptyAssistantMessage(assistantId: string): void {
    setMessages((prev) =>
      prev.filter(
        (m) =>
          !(
            m.id === assistantId &&
            m.role === "assistant" &&
            m.content.trim() === ""
          )
      )
    );
  }

  function filterBlankAssistantMessages(messagesForApi: ChatMessage[]): ChatMessage[] {
    return messagesForApi.filter(
      (m) => !(m.role === "assistant" && m.content.trim() === "")
    );
  }

  function buildTestRunSummary(result: RunCodeResult & {
    hiddenPassedCount?: number;
    hiddenFailedCount?: number;
  }): TestRunSummary {
    const hiddenPassedCount = result.hiddenPassedCount ?? 0;
    const hiddenFailedCount = result.hiddenFailedCount ?? 0;
    return {
      visiblePassed: result.passed,
      hiddenPassed: result.hiddenPassed,
      passedCount:
        result.results.filter((r) => r.passed).length + hiddenPassedCount,
      failedCount:
        result.results.filter((r) => !r.passed).length + hiddenFailedCount,
      hiddenFailedCount,
      // Visible cases only — hidden test data never reaches the client.
      cases: result.results.map((r) => ({ ...r, hidden: false })),
    };
  }

  function buildCurrentSessionState(): SessionState {
    const phase = sessionPhaseRef.current;
    return {
      phase,
      editorLocked: phase === "clarifying" || phase === "planning",
      roundEndsAt:
        roundStartTimeRef.current !== null
          ? roundStartTimeRef.current + ROUND_DURATION_MS
          : null,
      followUpTurnsUsed: followUpsReachedCountRef.current,
      testRunsUsed: runCountRef.current,
      lastTestResult: lastTestResultRef.current,
      currentCode: codeRef.current,
      snapshots: getSnapshots(),
      topicsProbed: topicsProbedRef.current,
      transcript: transcriptRef.current,
      forcedWrap: forcedWrapRef.current,
      followUpSegment: followUpSegmentRef.current,
      question: {
        id: question.id,
        title: question.title,
        difficulty: question.difficulty,
        candidateDescription: question.candidateDescription,
        // interviewerContext is intentionally omitted — the browser never holds
        // it; /api/interviewer injects it server-side from the question bank.
        testCases: question.testCases,
        entryFunction: question.entryFunction,
        followUps: question.followUps,
      },
    };
  }

  function handleAgentDataEvent(
    event: InterviewerDataEvent,
    assistantId?: string
  ): void {
    if (event.type === "summary") {
      if (event.value.trim().length >= 30) {
        rollingContextRef.current = event.value;
      }
      return;
    }
    if (event.type === "error") {
      // Route to this stream's own bubble; fall back to the shared ref for any
      // call site that hasn't bound an id.
      const targetId = assistantId ?? currentAgentAssistantIdRef.current;
      if (targetId == null) {
        return;
      }
      const errText = event.message;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === targetId
            ? {
                ...m,
                content: m.content
                  ? `${m.content}\n\n[Error: ${errText}]`
                  : `[Error: ${errText}]`,
              }
            : m
        )
      );
      return;
    }
    if (event.type === "tool_result" && event.tool === "run_tests") {
      const result = event.result;
      if (
        !result ||
        typeof result !== "object" ||
        !("rejected" in result) ||
        typeof (result as { rejected: unknown }).rejected !== "boolean" ||
        (result as { rejected: boolean }).rejected
      ) {
        return;
      }
      const r = result as {
        visiblePassed?: unknown;
        hiddenPassed?: unknown;
        passedCount?: unknown;
        failedCount?: unknown;
        hiddenFailedCount?: unknown;
        visibleCases?: unknown;
      };
      if (
        typeof r.visiblePassed !== "boolean" ||
        typeof r.hiddenPassed !== "boolean" ||
        typeof r.passedCount !== "number" ||
        typeof r.failedCount !== "number" ||
        typeof r.hiddenFailedCount !== "number" ||
        !Array.isArray(r.visibleCases)
      ) {
        return;
      }
      const visibleCases = r.visibleCases.filter(
        (c): c is TestResult =>
          c !== null &&
          typeof c === "object" &&
          "input" in c &&
          typeof (c as { input: unknown }).input === "string" &&
          "expected" in c &&
          typeof (c as { expected: unknown }).expected === "string" &&
          "actual" in c &&
          typeof (c as { actual: unknown }).actual === "string" &&
          "passed" in c &&
          typeof (c as { passed: unknown }).passed === "boolean"
      );
      lastTestResultRef.current = {
        visiblePassed: r.visiblePassed,
        hiddenPassed: r.hiddenPassed,
        passedCount: r.passedCount,
        failedCount: r.failedCount,
        hiddenFailedCount: r.hiddenFailedCount,
        cases: visibleCases.map((c) => ({ ...c, hidden: false })),
      };
      const nextRunCount = runCountRef.current + 1;
      runCountRef.current = nextRunCount;
      setRunCount(nextRunCount);
      setTestResults(visibleCases);
      setTestAllPassed(r.visiblePassed);
      setTestRunError(null);
      return;
    }
  }

  function transitionPlanningToCoding(): void {
    if (sessionPhaseRef.current !== "planning") {
      return;
    }
    const t0 = Date.now();
    setSessionPhase("coding");
    sessionPhaseRef.current = "coding";
    setCodingStartedAt(t0);
    phaseStartTimeRef.current = t0;
    setPhaseStartTime(t0);
    startSnapshots(
      () => codeRef.current,
      () => formatTranscriptLog(transcriptRef.current)
    );
  }

  function handleOpenEditorPlanning(): void {
    if (isStreamingRef.current || sessionPhaseRef.current !== "planning") {
      return;
    }
    transitionPlanningToCoding();
  }

  function getRemainingRoundMsNow(): number {
    const start = roundStartTimeRef.current;
    if (start === null) {
      return ROUND_DURATION_MS;
    }
    return Math.max(0, ROUND_DURATION_MS - (Date.now() - start));
  }

  function skipRemainingBankedFollowUps(): void {
    const len = question.followUps?.length ?? 0;
    currentFollowUpIndexRef.current = len;
    setCurrentFollowUpIndex(len);
  }

  /** Schedules a proactive in-editor banked variant. Returns true if one was queued. */
  function tryScheduleBankedCodingEscalation(): boolean {
    if (
      sessionPhaseRef.current !== "coding" ||
      forcedWrapRef.current ||
      isStreamingRef.current
    ) {
      return false;
    }
    // Baseline correctness comes first: never introduce (and so never let the
    // model pre-solve-skip) a harder variant until the baseline has passed
    // visible+hidden. getPendingBankedFollowUp also enforces this; the explicit
    // guard keeps the invariant local and refactor-proof.
    if (baselineSolvedAtRef.current === null) {
      return false;
    }
    const pending = getPendingBankedFollowUp(
      question.followUps,
      currentFollowUpIndexRef.current,
      baselineSolvedAtRef.current,
      getRemainingRoundMsNow()
    );
    if (pending === null) {
      return false;
    }
    // The index advance is staged here and committed by runCodingEscalationNudge
    // only after the introduction turn actually completes.
    pendingProactiveBankedNextIndexRef.current = pending.index + 1;
    pendingProactiveEscalationHintRef.current = buildBankedEscalationHint(
      pending.followUp
    );
    pendingProactiveBankedRef.current = true;
    queueMicrotask(() => {
      void runCodingEscalationNudge();
    });
    return true;
  }

  function buildPaceReport(): PaceReport {
    const codingStart = codingStartedAt;
    const baselineMs = baselineSolvedAtRef.current;
    const baselineMinutes =
      codingStart !== null && baselineMs !== null
        ? (baselineMs - codingStart) / 60_000
        : null;
    return {
      baselineMinutes,
      followUpsReached: followUpsReachedCountRef.current,
      followUpsAvailable: question.followUps?.length ?? 0,
      ranOutOfTime:
        roundTimedOutRef.current &&
        followUpsReachedCountRef.current < (question.followUps?.length ?? 0),
      bruteForceSkipped: bruteForceSkippedRef.current,
      escalationsAttempted: codingEscalationStepRef.current,
      forcedWrap: forcedWrapRef.current,
    };
  }

  async function runCodingEscalationNudge(): Promise<void> {
    if (
      sessionPhaseRef.current !== "coding" ||
      isStreamingRef.current ||
      forcedWrapRef.current
    ) {
      return;
    }
    const hint = pendingProactiveEscalationHintRef.current;
    if (!hint) {
      return;
    }
    // Consume so a duplicate scheduling doesn't fire twice.
    pendingProactiveEscalationHintRef.current = null;
    const wasBanked = pendingProactiveBankedRef.current;
    pendingProactiveBankedRef.current = false;
    const bankedNextIndex = pendingProactiveBankedNextIndexRef.current;
    pendingProactiveBankedNextIndexRef.current = null;

    const myGen = ++escalationNudgeGenRef.current;
    const assistantId = crypto.randomUUID();
    const historyForNudge = messagesRef.current;
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "" },
    ]);
    markStreamStart(assistantId);
    pauseBgForAiRef.current = true;
    groqAmbientRef.current?.pauseForFocus();
    let streamOk = false;
    let fullStreamed = "";
    let segmentWrapped = false;
    try {
      // Folded into the single interviewer brain: instead of a separate scripted
      // /api/ai nudge, the app feeds the escalation trigger + selected variant as
      // an explicit hint in this turn's state, and the model speaks it from the
      // harvested coding-phase craft. App owns the trigger + variant selection;
      // the model only produces the wording.
      const msgsForNudge = filterBlankAssistantMessages(historyForNudge);
      const escalationState: SessionState = {
        ...buildCurrentSessionState(),
        codingEscalationHint: hint,
      };
      for await (const chunk of streamInterviewerApi(
        {
          sessionState: escalationState,
          messages: msgsForNudge,
          rollingSummary: rollingContextRef.current ?? "",
          transcript: transcriptRef.current,
          turnCount: Math.floor(msgsForNudge.length / 2),
          modelPresetId: modelPresetIdRef.current,
        },
        (e) => handleAgentDataEvent(e, assistantId),
        streamAbortRef.current?.signal
      )) {
        if (myGen !== escalationNudgeGenRef.current) {
          return;
        }
        fullStreamed += chunk;
        const display = stripSegmentDone(fullStreamed).cleaned;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: display } : m
          )
        );
      }
      // Part 3 skip: the model may decide the current code already satisfies the
      // variant and emit [segment-complete] instead of introducing it.
      if (stripSegmentDone(fullStreamed).found) {
        pendingSegmentAdvanceRef.current = true;
        segmentWrapped = true;
      }
      streamOk = true;
    } catch (e) {
      if (myGen !== escalationNudgeGenRef.current) {
        return;
      }
      const errText = e instanceof Error ? e.message : String(e);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: m.content
                  ? `${m.content}\n\n[Error: ${errText}]`
                  : `[Error: ${errText}]`,
              }
            : m
        )
      );
    } finally {
      if (myGen === escalationNudgeGenRef.current) {
        setIsStreaming(false);
        clearStreamingId(assistantId);
        if (segmentWrapped) {
          dropEmptyAssistantMessage(assistantId);
        } else {
          finalizeAssistantMessage(assistantId);
        }
        pauseBgForAiRef.current = false;
        if (streamOk) {
          codingEscalationStepRef.current += 1;
          if (wasBanked) {
            // Variant delivered (introduced, or pre-solve-skipped via
            // [segment-complete]) — commit the staged index so this variant is
            // consumed. A failed stream skips this, leaving it pending for the
            // next advance to retry.
            if (bankedNextIndex !== null) {
              currentFollowUpIndexRef.current = bankedNextIndex;
              setCurrentFollowUpIndex(bankedNextIndex);
            }
            const next = followUpsReachedCountRef.current + 1;
            if (next > FOLLOW_UP_SAFETY_CAP) {
              if (process.env.NODE_ENV === "development") {
                console.warn(
                  "[InterviewWorkspace] banked-escalation follow-up increment skipped — cap would be exceeded",
                  {
                    current: followUpsReachedCountRef.current,
                    cap: FOLLOW_UP_SAFETY_CAP,
                  }
                );
              }
            } else {
              followUpsReachedCountRef.current = next;
              setFollowUpsReachedCount(next);
            }
          }
        }
        if (sessionPhaseRef.current === "coding" && !focusedMicRef.current) {
          groqAmbientRef.current?.resumeFromFocus();
        }
      }
    }
  }

  function beginForcedVerbalWrapTransition(): void {
    if (sessionPhaseRef.current !== "coding" || forcedWrapRef.current) {
      return;
    }
    forcedWrapRef.current = true;
    setForcedWrap(true);
    stopSnapshots();
    groqAmbientRef.current?.stop();
    followUpGenRef.current += 1;
    followUpSegmentRef.current = "final";
    setFollowUpSegment("final");
    followUpAssistantTurnsRef.current = 0;
    followUpSealedRef.current = false;
    setFollowUpSealed(false);
    sliceAwaitingCandidateReplyRef.current = false;
    sliceForceWrapUpRef.current = false;
    setSliceGraceReply(false);
    setSessionPhase("followUp");
    sessionPhaseRef.current = "followUp";
    const tNow = Date.now();
    phaseStartTimeRef.current = tNow;
    setPhaseStartTime(tNow);
  }

  async function runForcedWrapOpener(): Promise<void> {
    if (
      !forcedWrapRef.current ||
      sessionPhaseRef.current !== "followUp" ||
      isStreamingRef.current
    ) {
      return;
    }
    const myGen = ++forcedWrapOpenerGenRef.current;
    const assistantId = crypto.randomUUID();
    const historyForApi = filterBlankAssistantMessages(messagesRef.current);
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "" },
    ]);
    markStreamStart(assistantId);
    pauseBgForAiRef.current = true;
    groqAmbientRef.current?.pauseForFocus();
    currentAgentAssistantIdRef.current = assistantId;
    let fullStreamed = "";
    let segmentWrapped = false;
    try {
      for await (const chunk of streamInterviewerApi(
        {
          sessionState: buildCurrentSessionState(),
          messages: historyForApi,
          rollingSummary: rollingContextRef.current ?? "",
          transcript: transcriptRef.current,
          turnCount: Math.floor(historyForApi.length / 2),
          modelPresetId: modelPresetIdRef.current,
        },
        (e) => handleAgentDataEvent(e, assistantId),
        streamAbortRef.current?.signal
      )) {
        if (myGen !== forcedWrapOpenerGenRef.current) {
          return;
        }
        fullStreamed += chunk;
        const display = stripSegmentDone(fullStreamed).cleaned;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: display } : m
          )
        );
      }
      if (stripSegmentDone(fullStreamed).found) {
        pendingSegmentAdvanceRef.current = true;
        segmentWrapped = true;
      }
    } catch (e) {
      if (myGen !== forcedWrapOpenerGenRef.current) {
        return;
      }
      const errText = e instanceof Error ? e.message : String(e);
      appendErrorToMessage(assistantId, errText);
    } finally {
      if (myGen === forcedWrapOpenerGenRef.current) {
        setIsStreaming(false);
        clearStreamingId(assistantId);
        if (segmentWrapped) {
          dropEmptyAssistantMessage(assistantId);
        } else {
          finalizeAssistantMessage(assistantId);
        }
        pauseBgForAiRef.current = false;
        // From now on, candidate replies during forced-wrap should carry the
        // assess+handoff HINT.
        forcedWrapHintPendingRef.current = true;
      }
    }
  }

  /**
   * @returns false if the message was not sent (e.g. assistant still streaming).
   */
  async function sendUserMessage(text: string): Promise<boolean> {
    if (
      isStreamingRef.current ||
      sessionPhaseRef.current === "feedback"
    ) {
      return false;
    }
    if (
      sessionPhaseRef.current === "followUp" &&
      followUpSealedRef.current
    ) {
      return false;
    }

    if (sessionPhaseRef.current === "coding") {
      pauseBgForAiRef.current = true;
      groqAmbientRef.current?.pauseForFocus();
    }

    const now = Date.now();
    const phaseElapsedMs =
      phaseStartTimeRef.current !== null
        ? now - phaseStartTimeRef.current
        : null;

    // One-shot phase-budget nudge: mark the phase as nudged the first time we
    // cross its budget so future turns don't re-trigger.
    const phaseBudget = PHASE_BUDGET_MS[sessionPhaseRef.current];
    if (
      phaseBudget !== null &&
      phaseElapsedMs !== null &&
      phaseElapsedMs > phaseBudget &&
      !phaseBudgetNudgedRef.current[sessionPhaseRef.current]
    ) {
      phaseBudgetNudgedRef.current = {
        ...phaseBudgetNudgedRef.current,
        [sessionPhaseRef.current]: true,
      };
    }

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    const assistantId = crypto.randomUUID();
    const phaseNow = sessionPhaseRef.current;
    const sliceWrapUpThisTurn =
      phaseNow === "followUp" &&
      followUpSegmentRef.current === "slice" &&
      sliceAwaitingCandidateReplyRef.current;
    if (sliceWrapUpThisTurn) {
      sliceForceWrapUpRef.current = true;
    }
    const msgsForApi: ChatMessage[] = filterBlankAssistantMessages([
      ...messages,
      userMsg,
    ]);

    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: "assistant", content: "" },
    ]);
    markStreamStart(assistantId);

    const applyHumanLatency = humanLatency;
    let messageStreamOk = false;
    // True once this turn emitted [segment-complete] AND is advancing the segment:
    // an empty bubble here is a deliberate wrap, not weak-caller silence.
    let segmentWrapped = false;
    if (phaseNow === "coding") {
      lastSentAmbientCutoffRef.current = now;
    }
    try {
      // Phase-advance signal detection: AI may prefix its reply with [->planning]
      // or [->coding] (on its own line) to trigger a seamless phase transition.
      // We buffer the first bytes, strip the token if present, then stream normally.
      const SIG_PLAN = "[->planning]";
      const SIG_CODE = "[->coding]";
      let phaseSignal: "planning" | "coding" | null = null;
      let sigBuf = "";
      let sigFlushed = false;
      let fullStreamedContent = "";

      currentAgentAssistantIdRef.current = assistantId;

      let firstChunk = true;
      let charCount = 0;
      for await (const chunk of streamInterviewerApi(
        {
          sessionState: buildCurrentSessionState(),
          messages: msgsForApi,
          rollingSummary: rollingContextRef.current ?? "",
          transcript: transcriptRef.current,
          turnCount: Math.floor(msgsForApi.length / 2),
          modelPresetId: modelPresetIdRef.current,
        },
        (e) => handleAgentDataEvent(e, assistantId),
        streamAbortRef.current?.signal
      )) {
        fullStreamedContent += chunk;
        // Buffer the very start until we can determine if a signal is present.
        let displayChunk = chunk;
        if (!sigFlushed) {
          sigBuf += chunk;
          // Wait until we have at least as many chars as the longer signal,
          // or the first newline arrives — whichever comes first.
          if (sigBuf.length < SIG_PLAN.length && !sigBuf.includes("\n")) {
            continue;
          }
          sigFlushed = true;
          let start = 0;
          if (sigBuf.startsWith(SIG_PLAN)) {
            phaseSignal = "planning";
            start = SIG_PLAN.length;
            if (sigBuf[start] === "\n") start++;
          } else if (sigBuf.startsWith(SIG_CODE)) {
            phaseSignal = "coding";
            start = SIG_CODE.length;
            if (sigBuf[start] === "\n") start++;
          }
          displayChunk = sigBuf.slice(start);
        }

        if (firstChunk && applyHumanLatency) {
          firstChunk = false;
          await new Promise<void>((r) =>
            setTimeout(r, 1500 + Math.random() * 2500)
          );
        } else {
          firstChunk = false;
        }
        charCount += displayChunk.length;
        if (applyHumanLatency && charCount > 320) {
          continue;
        }
        if (displayChunk) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + displayChunk } : m
            )
          );
        }
      }
      // Safety: if the stream ended while still buffering, flush whatever we have.
      if (!sigFlushed && sigBuf) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + sigBuf } : m
          )
        );
      }
      // Fallback: if the AI buried the signal token in the body rather than leading
      // with it, scan the full response and strip it from the displayed message.
      if (phaseSignal === null) {
        if (fullStreamedContent.includes(SIG_CODE)) {
          phaseSignal = "coding";
        } else if (fullStreamedContent.includes(SIG_PLAN)) {
          phaseSignal = "planning";
        }
        if (phaseSignal !== null) {
          const cleaned = fullStreamedContent
            .replace(/\[->planning\]\n?/g, "")
            .replace(/\[->coding\]\n?/g, "")
            .trim();
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: cleaned } : m
            )
          );
        }
      }
      if (
        phaseSignal === null &&
        phaseNow === "planning" &&
        assistantInvitesCodingWithoutToken(fullStreamedContent)
      ) {
        phaseSignal = "coding";
      }

      // Human-latency mode skips streaming chunks past 320 chars to feel like
      // typing; flush the complete (signal-stripped) reply once the stream ends
      // so long replies are not left truncated/blank in the UI.
      if (applyHumanLatency && fullStreamedContent.trim()) {
        const cleanedFull = fullStreamedContent
          .replace(/\[->planning\]\n?/g, "")
          .replace(/\[->coding\]\n?/g, "")
          .trim();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: cleanedFull } : m
          )
        );
      }

      // Segment-complete signal: the model wraps a review / final Q&A (or skips
      // an already-solved variant) by emitting [segment-complete], usually on its
      // own final line. Strip it from the display and let the app advance once
      // this stream ends. Gate the advance to post-baseline turns so a stray
      // token during baseline coding can't jump the interview forward.
      if (fullStreamedContent.includes(SEGMENT_DONE_TOKEN)) {
        const cleaned = stripSegmentDone(
          fullStreamedContent
            .replace(/\[->planning\]\n?/g, "")
            .replace(/\[->coding\]\n?/g, "")
        ).cleaned;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: cleaned } : m
          )
        );
        // Hold the advance if this slice-review turn still asks a question — the
        // candidate must get to answer it before we move on, even if the model
        // wrongly bundled the wrap token. The turn cap (FOLLOW_UP_SLICE_SAFETY_CAP)
        // still backstops a model that never stops asking. Final-segment wraps are
        // unaffected (followUpSegment is "final" there, not "slice").
        const holdForAnswer =
          isSliceReview(followUpSegmentRef.current) && endsWithQuestion(cleaned);
        if (
          (phaseNow === "followUp" || baselineSolvedAtRef.current !== null) &&
          !holdForAnswer
        ) {
          pendingSegmentAdvanceRef.current = true;
          segmentWrapped = true;
        }
      }

      messageStreamOk = true;

      // Apply AI-driven phase transition (signal was stripped from the message above).
      if (phaseSignal === "planning" && phaseNow === "clarifying") {
        setSessionPhase("planning");
        sessionPhaseRef.current = "planning";
        const t = Date.now();
        phaseStartTimeRef.current = t;
        setPhaseStartTime(t);
      } else if (phaseSignal === "coding" && phaseNow === "planning") {
        transitionPlanningToCoding();
      }
    } catch (e) {
      // The agent route surfaces errors via handleAgentDataEvent's "error"
      // branch, which already appends to the assistant bubble. The helper
      // dedups so this fallback path safely covers network/abort/JS errors
      // that bypass the data stream.
      const errText = e instanceof Error ? e.message : String(e);
      appendErrorToMessage(assistantId, errText);
    } finally {
      setIsStreaming(false);
      clearStreamingId(assistantId);
      if (segmentWrapped) {
        dropEmptyAssistantMessage(assistantId);
      } else {
        finalizeAssistantMessage(assistantId);
      }
      pauseBgForAiRef.current = false;
      if (
        phaseNow === "followUp" &&
        messageStreamOk &&
        sessionPhaseRef.current === "followUp"
      ) {
        followUpAssistantTurnsRef.current += 1;
        const turns = followUpAssistantTurnsRef.current;
        const roundStartNow = roundStartTimeRef.current;
        const remainingNow =
          roundStartNow !== null
            ? Math.max(0, ROUND_DURATION_MS - (Date.now() - roundStartNow))
            : ROUND_DURATION_MS;
        const outOfTime =
          remainingNow <= FOLLOW_UP_AUTO_CLOSE_REMAINING_MS ||
          roundTimedOutRef.current;
        const sliceSegment = followUpSegmentRef.current === "slice";
        const cap = sliceSegment
          ? FOLLOW_UP_SLICE_SAFETY_CAP
          : FOLLOW_UP_SAFETY_CAP;
        const hitSafety = turns >= cap;
        if (outOfTime) {
          pendingSegmentAdvanceRef.current = true;
        } else if (hitSafety && !sliceSegment) {
          // Final Q&A cap: force advance. Slice reviews are exempt — only a
          // real [segment-complete] or outOfTime should advance them. The
          // round timer (FOLLOW_UP_AUTO_CLOSE_REMAINING_MS) backstops a
          // model that never wraps.
          pendingSegmentAdvanceRef.current = true;
        }
      }
      if (
        sessionPhaseRef.current === "coding" &&
        !focusedMicRef.current
      ) {
        groqAmbientRef.current?.resumeFromFocus();
      }
    }
    return true;
  }

  function handleMicPointerDown() {
    if (
      !speechSupported ||
      sessionPhase === "feedback" ||
      isStreaming ||
      whisperTranscribing
    ) {
      return;
    }
    if (sessionPhase === "coding") {
      focusedMicRef.current = true;
    }
    focusMicHeldRef.current = true;
    setLiveCaption("");

    // Pause ambient chunk so focused question audio doesn't bleed in.
    groqAmbientRef.current?.pauseForFocus();

    void (async () => {
      try {
        await focusMic.startHold(focusMicHeldRef);
        if (focusMicHeldRef.current) {
          setLiveCaption("Recording… release to transcribe");
        }
      } catch (e) {
        const errText = e instanceof Error ? e.message : String(e);
        setSpeechError(`Could not start microphone: ${errText}`);
        focusMicHeldRef.current = false;
        if (sessionPhaseRef.current === "coding") {
          focusedMicRef.current = false;
        }
        focusMic.abort();
        groqAmbientRef.current?.resumeFromFocus();
      }
    })();
  }

  async function handleMicPointerUp() {
    if (!speechSupported || sessionPhase === "feedback") {
      return;
    }

    focusMicHeldRef.current = false;
    setLiveCaption("");
    focusMic.setTranscribing(true);
    let msg = "";
    try {
      const blob = await focusMic.stopToBlob();
      if (blob) {
        msg = (await transcribeWithGroqWhisper(blob)).trim();
      }
    } catch (e) {
      const errText = e instanceof Error ? e.message : String(e);
      setSpeechError(`Transcription failed: ${errText}`);
    } finally {
      focusMic.setTranscribing(false);
      groqAmbientRef.current?.resumeFromFocus();
    }

    if (sessionPhaseRef.current === "coding") {
      focusedMicRef.current = false;
    }
    if (msg) {
      await sendUserMessage(msg);
    }
  }

  // Review turn triggered by a candidate Submit. Opens from the submit grade
  // (post-pass acknowledgment or a ground-truth probe of the failed hidden case)
  // and closes when the model emits [segment-complete].
  async function enterSubmitReview(): Promise<void> {
    if (isStreamingRef.current) {
      return;
    }

    pendingSegmentAdvanceRef.current = false;
    stopSnapshots();
    followUpSegmentRef.current = "slice";
    setFollowUpSegment("slice");
    followUpAssistantTurnsRef.current = 0;
    followUpSealedRef.current = false;
    setFollowUpSealed(false);
    sliceAwaitingCandidateReplyRef.current = false;
    sliceForceWrapUpRef.current = false;
    setSliceGraceReply(false);
    setSessionPhase("followUp");
    sessionPhaseRef.current = "followUp";
    const tNow = Date.now();
    phaseStartTimeRef.current = tNow;
    setPhaseStartTime(tNow);

    const myGen = ++followUpGenRef.current;
    const assistantId = crypto.randomUUID();
    const historyForApi = filterBlankAssistantMessages(messagesRef.current);

    // Fold the counts-only submit grade into this one turn's state, then consume
    // it so later turns in the review don't keep re-opening from the grade.
    const reviewState: SessionState = {
      ...buildCurrentSessionState(),
      ...(pendingSubmitHintRef.current
        ? { submitReviewHint: pendingSubmitHintRef.current }
        : {}),
    };
    pendingSubmitHintRef.current = null;

    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "" },
    ]);
    markStreamStart(assistantId);
    currentAgentAssistantIdRef.current = assistantId;

    let fullStreamed = "";
    let segmentWrapped = false;
    try {
      for await (const chunk of streamInterviewerApi(
        {
          sessionState: reviewState,
          messages: historyForApi,
          rollingSummary: rollingContextRef.current ?? "",
          transcript: transcriptRef.current,
          turnCount: Math.floor(historyForApi.length / 2),
          modelPresetId: modelPresetIdRef.current,
        },
        (e) => handleAgentDataEvent(e, assistantId),
        streamAbortRef.current?.signal
      )) {
        if (myGen !== followUpGenRef.current) {
          return;
        }
        fullStreamed += chunk;
        const display = stripSegmentDone(fullStreamed).cleaned;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: display } : m
          )
        );
      }
      const wrapResult = stripSegmentDone(fullStreamed);
      // Hold the advance if a slice-review wrap still poses a question: an
      // over-eager caller sometimes appends [segment-complete] to the same turn it
      // asks its one focused question (e.g. the opener), which would skip the
      // candidate's answer. Final-segment wraps are unaffected (followUpSegment is
      // "final" there, so holdForAnswer is always false).
      if (
        wrapResult.found &&
        !(
          isSliceReview(followUpSegmentRef.current) &&
          endsWithQuestion(wrapResult.cleaned)
        )
      ) {
        pendingSegmentAdvanceRef.current = true;
        segmentWrapped = true;
      }
    } catch (e) {
      if (myGen !== followUpGenRef.current) {
        return;
      }
      const errText = e instanceof Error ? e.message : String(e);
      appendErrorToMessage(assistantId, errText);
    } finally {
      if (myGen === followUpGenRef.current) {
        setIsStreaming(false);
        clearStreamingId(assistantId);
        if (segmentWrapped) {
          dropEmptyAssistantMessage(assistantId);
        } else {
          finalizeAssistantMessage(assistantId);
        }
        followUpAssistantTurnsRef.current = 1;
      }
    }
  }

  async function enterFinalFollowUpPhase(): Promise<void> {
    pendingSegmentAdvanceRef.current = false;
    stopSnapshots();
    followUpSegmentRef.current = "final";
    setFollowUpSegment("final");
    followUpAssistantTurnsRef.current = 0;
    followUpSealedRef.current = false;
    setFollowUpSealed(false);
    sliceAwaitingCandidateReplyRef.current = false;
    sliceForceWrapUpRef.current = false;
    setSliceGraceReply(false);
    setSessionPhase("followUp");
    sessionPhaseRef.current = "followUp";
    const tNow = Date.now();
    phaseStartTimeRef.current = tNow;
    setPhaseStartTime(tNow);

    const myGen = ++followUpGenRef.current;
    const assistantId = crypto.randomUUID();
    const historyForApi = filterBlankAssistantMessages(messagesRef.current);

    setMessages((prev) => [
      ...prev,
      {
        id: assistantId,
        role: "assistant",
        content: "",
      },
    ]);
    markStreamStart(assistantId);
    currentAgentAssistantIdRef.current = assistantId;

    let fullStreamed = "";
    let segmentWrapped = false;
    try {
      for await (const chunk of streamInterviewerApi(
        {
          sessionState: buildCurrentSessionState(),
          messages: historyForApi,
          rollingSummary: rollingContextRef.current ?? "",
          transcript: transcriptRef.current,
          turnCount: Math.floor(historyForApi.length / 2),
          modelPresetId: modelPresetIdRef.current,
        },
        (e) => handleAgentDataEvent(e, assistantId),
        streamAbortRef.current?.signal
      )) {
        if (myGen !== followUpGenRef.current) {
          return;
        }
        fullStreamed += chunk;
        const display = stripSegmentDone(fullStreamed).cleaned;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: display } : m
          )
        );
      }
      const wrapResult = stripSegmentDone(fullStreamed);
      // Hold the advance if a slice-review wrap still poses a question: an
      // over-eager caller sometimes appends [segment-complete] to the same turn it
      // asks its one focused question (e.g. the opener), which would skip the
      // candidate's answer. Final-segment wraps are unaffected (followUpSegment is
      // "final" there, so holdForAnswer is always false).
      if (
        wrapResult.found &&
        !(
          isSliceReview(followUpSegmentRef.current) &&
          endsWithQuestion(wrapResult.cleaned)
        )
      ) {
        pendingSegmentAdvanceRef.current = true;
        segmentWrapped = true;
      }
    } catch (e) {
      if (myGen !== followUpGenRef.current) {
        return;
      }
      const errText = e instanceof Error ? e.message : String(e);
      appendErrorToMessage(assistantId, errText);
    } finally {
      if (myGen === followUpGenRef.current) {
        setIsStreaming(false);
        clearStreamingId(assistantId);
        if (segmentWrapped) {
          dropEmptyAssistantMessage(assistantId);
        } else {
          finalizeAssistantMessage(assistantId);
        }
        followUpAssistantTurnsRef.current = 1;
      }
    }
  }

  // Re-enter coding so the candidate can implement the next variant (Run/Submit
  // become available again). Used by advanceAfterSegmentComplete.
  function enterCodingForVariant(): void {
    pendingSegmentAdvanceRef.current = false;
    setSubmitOutcome(null);
    // Each variant is a fresh thing to submit — clear the last-submission identity
    // so the FIRST submit of the variant always fires a review (not suppressed as
    // "unchanged" against the baseline submission).
    lastSubmittedCodeRef.current = null;
    lastSubmitOutcomeRef.current = null;
    followUpGenRef.current += 1;
    followUpSealedRef.current = false;
    setFollowUpSealed(false);
    sliceAwaitingCandidateReplyRef.current = false;
    sliceForceWrapUpRef.current = false;
    setSliceGraceReply(false);
    setSessionPhase("coding");
    sessionPhaseRef.current = "coding";
    const tNow = Date.now();
    phaseStartTimeRef.current = tNow;
    setPhaseStartTime(tNow);
    if (codingStartedAt === null) {
      setCodingStartedAt(tNow);
    }
    startSnapshots(
      () => codeRef.current,
      () => formatTranscriptLog(transcriptRef.current)
    );
  }

  // Deterministic transition after a [segment-complete] (or a backstop). The app
  // — NOT the model's token — owns the advance decision. The token is advisory:
  // a weak caller (or a confused strong one) will emit it even on a failing
  // submit, and we must not let that end the segment.
  function advanceAfterSegmentComplete(): void {
    if (sessionPhaseRef.current === "feedback" || isStreamingRef.current) {
      return;
    }
    // Forced verbal wrap, or the final Q&A segment completing → end the round.
    if (
      forcedWrapRef.current ||
      (sessionPhaseRef.current === "followUp" &&
        followUpSegmentRef.current === "final")
    ) {
      void runFinalFeedbackStream();
      return;
    }

    // Baseline-solved gate. baselineSolvedAt is set ONLY when a Submit passes both
    // visible AND hidden, so until it is set the problem is not actually solved.
    // A [segment-complete] on such a failing submit must NOT advance:
    //   - time remains → ignore the token and stay put. The candidate is in the
    //     review with the editor unlocked and Submit available again, so they can
    //     fix the bug and re-submit. Correctness comes before any harder variant.
    //   - out of time → give up gracefully: wrap to the final segment, and the
    //     round-clock / forced-wrap backstops drive feedback from there.
    if (baselineSolvedAtRef.current === null) {
      const outOfTime =
        roundTimedOutRef.current ||
        getRemainingRoundMsNow() <= FOLLOW_UP_AUTO_CLOSE_REMAINING_MS;
      if (outOfTime) {
        void enterFinalFollowUpPhase();
      }
      return;
    }

    // Baseline solved → advance: next banked variant if one fits, else final Q&A.
    const pending = getPendingBankedFollowUp(
      question.followUps,
      currentFollowUpIndexRef.current,
      baselineSolvedAtRef.current,
      getRemainingRoundMsNow()
    );
    if (pending !== null) {
      enterCodingForVariant();
      if (tryScheduleBankedCodingEscalation()) {
        return;
      }
    }
    void enterFinalFollowUpPhase();
  }

  // Submit = "evaluate me." Runs the FULL Judge0 set (visible + hidden — for a
  // variant this re-runs the baseline hidden cases), records the grade, then
  // opens Alex's review with the counts-only hint. Never hard-blocked by the run
  // cap (free submission); it still increments the shared counter.
  async function handleSubmit(): Promise<void> {
    // Submit is available while coding a baseline/variant, and also during a
    // submission review (followUp/slice) so the candidate can fix a failed
    // submission and re-submit it. Not in the final Q&A segment.
    const inReview =
      sessionPhaseRef.current === "followUp" &&
      followUpSegmentRef.current === "slice";
    if (
      isStreaming ||
      testRunLoadingRef.current ||
      forcedWrapRef.current ||
      (sessionPhaseRef.current !== "coding" && !inReview)
    ) {
      return;
    }
    if (runMode === "dry-run") {
      if (traceContent.trim().length === 0) {
        return;
      }
      // Trace mode: no execution — review the traced approach without a grade.
      pendingSubmitHintRef.current = null;
      setSubmitOutcome(null);
      await enterSubmitReview();
      return;
    }
    if (!codeRef.current.trim()) {
      setTestRunError("Add code before submitting.");
      return;
    }

    // Idempotent Submit: if nothing changed since the last submission, do NOT
    // fire a new review turn (that re-asks the question Alex just asked). Quietly
    // re-surface the last counts-only outcome and stop — no Judge0 grade, no
    // streaming turn, no segment advance, baselineSolvedAt untouched.
    const submittedCode = codeRef.current;
    const normalizedSubmission = normalizeSubmittedCode(submittedCode);
    if (
      lastSubmittedCodeRef.current !== null &&
      lastSubmittedCodeRef.current === normalizedSubmission
    ) {
      if (lastSubmitOutcomeRef.current) {
        setSubmitOutcome(`Already submitted — ${lastSubmitOutcomeRef.current}`);
      }
      return;
    }

    // Synchronous guard against a double-submit while the Judge0 call is in
    // flight (Submit does not set isStreaming, so the button stays enabled).
    testRunLoadingRef.current = true;
    setTestRunLoading(true);
    setTestRunError(null);
    try {
      const res = await fetch("/api/judge0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId: question.id,
          code: submittedCode,
          // Submit grades hidden cases — the route loads them server-side from
          // the question bank by questionId.
          includeHidden: true,
        }),
      });
      const data: unknown = await res.json();
      if (
        !res.ok ||
        typeof data !== "object" ||
        data === null ||
        !("passed" in data) ||
        !("results" in data) ||
        typeof (data as { passed: unknown }).passed !== "boolean" ||
        !Array.isArray((data as { results: unknown }).results)
      ) {
        const err =
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof (data as { error: unknown }).error === "string"
            ? (data as { error: string }).error
            : "Submission run failed";
        setTestRunError(err);
        pendingSubmitHintRef.current = null;
        setSubmitOutcome(null);
      } else {
        // The route returns aggregate counts for hidden cases — never the raw
        // hiddenResults array (input/expected/actual stay server-side).
        const runResult = data as RunCodeResult & {
          hiddenPassedCount?: number;
          hiddenFailedCount?: number;
          failedHiddenDescriptions?: string[];
        };
        const { passed, results, hiddenPassed } = runResult;
        lastTestResultRef.current = buildTestRunSummary(runResult);
        setTestResults(results);
        setTestAllPassed(passed);

        // Shared run counter — Submit increments it but is never blocked by it.
        const nextRun = runCountRef.current + 1;
        runCountRef.current = nextRun;
        setRunCount(nextRun);

        // First fully-passing submission with no prior failing run → the
        // candidate skipped the brute-force → optimal arc. Feeds the pace report.
        if (!firstTestRunConsumedRef.current) {
          firstTestRunConsumedRef.current = true;
          if (passed && hiddenPassed) {
            bruteForceSkippedRef.current = true;
          }
        }

        // Baseline counts as solved only when BOTH visible and hidden pass — this
        // gates whether banked variants are introduced after the review.
        if (passed && hiddenPassed && baselineSolvedAtRef.current === null) {
          baselineSolvedAtRef.current = Date.now();
        }

        const visiblePassedCount = results.filter((r) => r.passed).length;
        const hiddenPassedCount = runResult.hiddenPassedCount ?? 0;
        const hiddenFailedCount = runResult.hiddenFailedCount ?? 0;
        const hiddenTotal = hiddenPassedCount + hiddenFailedCount;
        // Descriptions of failed hidden cases come from the server response —
        // the browser no longer holds the hidden test cases themselves.
        const failedHiddenDescriptions = runResult.failedHiddenDescriptions ?? [];
        pendingSubmitHintRef.current = buildSubmitReviewHint({
          visiblePassed: passed,
          hiddenPassed,
          visiblePassedCount,
          visibleTotal: results.length,
          hiddenPassedCount,
          hiddenTotal,
          failedHiddenDescriptions,
        });
        const countsLabel = `visible ${visiblePassedCount}/${results.length}, hidden ${hiddenPassedCount}/${hiddenTotal}`;
        setSubmitOutcome(`Submitted — ${countsLabel}`);
        // Remember this graded submission (pass OR fail) so an unchanged
        // re-submit short-circuits instead of re-reviewing.
        lastSubmittedCodeRef.current = normalizedSubmission;
        lastSubmitOutcomeRef.current = countsLabel;
      }
    } catch (e) {
      setTestRunError(e instanceof Error ? e.message : String(e));
      pendingSubmitHintRef.current = null;
      setSubmitOutcome(null);
    } finally {
      testRunLoadingRef.current = false;
      setTestRunLoading(false);
    }

    // Submit always hands off to Alex's review, whatever the grade (or a Judge0
    // error — the review just opens without a grade in that case).
    await enterSubmitReview();
  }

  async function handleSkipToFinalFollowUp() {
    if (isStreaming) {
      return;
    }
    if (
      sessionPhaseRef.current === "coding" &&
      runMode === "dry-run" &&
      traceContent.trim().length === 0
    ) {
      return;
    }
    skipRemainingBankedFollowUps();
    await enterFinalFollowUpPhase();
  }

  async function runFinalFeedbackStream() {
    if (sessionPhaseRef.current === "feedback") {
      return;
    }
    if (isStreamingRef.current) {
      roundTimeoutFeedbackPendingRef.current = true;
      return;
    }

    followUpGenRef.current += 1;
    openingGenRef.current += 1;
    escalationNudgeGenRef.current += 1;
    stopSnapshots();
    groqAmbientRef.current?.stop();
    setSessionPhase("feedback");
    sessionPhaseRef.current = "feedback";
    const tNow = Date.now();
    phaseStartTimeRef.current = tNow;
    setPhaseStartTime(tNow);

    const feedbackId = crypto.randomUUID();
    const historyForFeedback = [...messagesRef.current];

    setMessages((prev) => [
      ...prev,
      {
        id: feedbackId,
        role: "assistant",
        content: "",
      },
    ]);
    markStreamStart(feedbackId);

    try {
      for await (const chunk of streamFeedbackApi({
        modelPresetId: modelPresetIdRef.current,
        question: problemStatement,
        fullTranscript: formatTranscriptLog(transcriptRef.current),
        snapshots: getSampledFeedbackSnapshots(),
        finalCode: codeRef.current,
        chatHistory: historyForFeedback,
        ...(traceContent.trim() ? { traceContent: traceContent.trim() } : {}),
        paceReport: buildPaceReport(),
        codingVoiceReport: buildCodingVoiceReport(transcriptRef.current),
      }, streamAbortRef.current?.signal)) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === feedbackId ? { ...m, content: m.content + chunk } : m
          )
        );
      }
    } catch (e) {
      const errText = e instanceof Error ? e.message : String(e);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === feedbackId
            ? {
                ...m,
                content: m.content
                  ? `${m.content}\n\n[Error: ${errText}]`
                  : `[Error: ${errText}]`,
              }
            : m
        )
      );
    } finally {
      setIsStreaming(false);
      clearStreamingId(feedbackId);
      finalizeAssistantMessage(feedbackId);
      setSessionPersistenceActive(false);
      clearPersistedInterviewSession(question.id);
    }
  }

  // Candidate end-action: explicitly finish the final Q&A and get the written
  // feedback. Kept as a candidate-facing control (alongside the model's
  // [segment-complete] signal and the round-clock backstop) so the interview is
  // never stuck waiting on a token. It generates feedback, not an empty turn.
  async function handleContinueToFeedback() {
    if (
      isStreaming ||
      sessionPhase !== "followUp" ||
      followUpSegment !== "final"
    ) {
      return;
    }
    await runFinalFeedbackStream();
  }

  runFinalFeedbackRef.current = () => {
    void runFinalFeedbackStream();
  };

  const MAX_LIMITED_RUNS = 3;

  // Run = private VISIBLE self-check. Executes only the visible cases, shows
  // pass/fail, and triggers NO interviewer turn. It deliberately does NOT touch
  // lastTestResultRef (the model's evidence reflects the last Submit, not casual
  // self-checks). Counts toward the shared run cap and is hard-blocked at it.
  async function handleRunTests() {
    if (forcedWrapRef.current) {
      // Editor locked for verbal wrap-up — no further runs accepted.
      return;
    }
    if (!codeRef.current.trim()) {
      setTestRunError("Add code before running tests.");
      setTestResults(null);
      setTestAllPassed(null);
      return;
    }
    if (runMode === "dry-run") {
      return; // button is hidden in dry-run mode
    }
    if (runMode === "limited" && runCountRef.current >= MAX_LIMITED_RUNS) {
      setTestRunError(`Run limit reached (${MAX_LIMITED_RUNS} runs used).`);
      return;
    }
    if (runCountRef.current >= TEST_RUNS_MAX) {
      setTestRunError(
        `Run limit reached (${TEST_RUNS_MAX} executions used). You can still Submit to be evaluated.`
      );
      return;
    }
    const next = runCountRef.current + 1;
    runCountRef.current = next;
    setRunCount(next);
    setTestRunLoading(true);
    setTestRunError(null);
    try {
      const res = await fetch("/api/judge0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId: question.id,
          code: codeRef.current,
          // Visible-only: a Run never executes hidden cases. Hidden grading is
          // reserved for Submit.
          includeHidden: false,
        }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        const err =
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof (data as { error: unknown }).error === "string"
            ? (data as { error: string }).error
            : "Request failed";
        setTestRunError(err);
        setTestResults(null);
        setTestAllPassed(null);
        return;
      }
      if (
        typeof data !== "object" ||
        data === null ||
        !("passed" in data) ||
        !("results" in data) ||
        typeof (data as { passed: unknown }).passed !== "boolean" ||
        !Array.isArray((data as { results: unknown }).results)
      ) {
        setTestRunError("Invalid response from server");
        setTestResults(null);
        setTestAllPassed(null);
        return;
      }
      const runResult = data as RunCodeResult;
      setTestResults(runResult.results);
      setTestAllPassed(runResult.passed);
    } catch (e) {
      setTestRunError(e instanceof Error ? e.message : String(e));
      setTestResults(null);
      setTestAllPassed(null);
    } finally {
      setTestRunLoading(false);
    }
  }

  function handleResetSession() {
    if (isStreaming) {
      return;
    }
    followUpGenRef.current += 1;
    followUpAssistantTurnsRef.current = 0;
    followUpSealedRef.current = false;
    setFollowUpSealed(false);
    sliceAwaitingCandidateReplyRef.current = false;
    sliceForceWrapUpRef.current = false;
    setSliceGraceReply(false);
    followUpSegmentRef.current = "final";
    setFollowUpSegment("final");
    stopSnapshots();
    // The useGroqAmbient hook will tear down on the next render when phase
    // leaves "coding"; force an immediate stop here too so the mic releases.
    groqAmbientRef.current?.stop();
    groqAmbientRef.current = null;
    focusMic.abort();
    focusMicHeldRef.current = false;
    focusedMicRef.current = false;
    pauseBgForAiRef.current = false;
    setSessionPhase("clarifying");
    setTranscript([]);
    transcriptRef.current = [];
    setLiveCaption("");
    setSpeechError(null);
    lastTestResultRef.current = null;
    setTestResults(null);
    setTestAllPassed(null);
    setTestRunError(null);
    setTestRunLoading(false);
    setCodingStartedAt(null);
    roundStartTimeRef.current = null;
    roundTimedOutRef.current = false;
    setRoundStartTime(null);
    phaseStartTimeRef.current = null;
    setPhaseStartTime(null);
    phaseBudgetNudgedRef.current = {};
    rollingContextRef.current = null;
    runCountRef.current = 0;
    setRunCount(0);
    setSubmitOutcome(null);
    pendingSubmitHintRef.current = null;
    lastSubmittedCodeRef.current = null;
    lastSubmitOutcomeRef.current = null;
    pendingProactiveEscalationHintRef.current = null;
    pendingProactiveBankedRef.current = false;
    pendingProactiveBankedNextIndexRef.current = null;
    pendingSegmentAdvanceRef.current = false;
    streamingAssistantIdRef.current = null;
    setStreamingAssistantId(null);
    escalationNudgeGenRef.current += 1;
    lastSentAmbientCutoffRef.current = 0;
    bruteForceSkippedRef.current = false;
    firstTestRunConsumedRef.current = false;
    followUpAutoCloseByTimeCheckedRef.current = false;
    baselineSolvedAtRef.current = null;
    codingEscalationStepRef.current = 0;
    forcedWrapRef.current = false;
    setForcedWrap(false);
    forcedWrapHintPendingRef.current = false;
    forcedHandoffScheduledRef.current = false;
    forcedWrapOpenerGenRef.current += 1;
    currentFollowUpIndexRef.current = 0;
    setCurrentFollowUpIndex(0);
    followUpsReachedCountRef.current = 0;
    setFollowUpsReachedCount(0);
    setTopicsProbed([]);
    topicsProbedRef.current = [];
    setTraceContent("");
    restoredSessionRef.current = false;
    setSessionPersistenceActive(true);
    clearPersistedInterviewSession(question.id);
    setEditorInitialCode(defaultInitialValue);
    setSessionResetKey((k) => k + 1);
    codeRef.current = defaultInitialValue;
  }

  handleRunTestsRef.current = () => {
    void handleRunTests();
  };
  handleSubmitRef.current = () => {
    void handleSubmit();
  };

  useCodingShortcuts({
    sessionPhaseRef,
    testRunLoadingRef,
    isStreamingRef,
    onRunTests: () => handleRunTestsRef.current(),
    onImDone: () => handleSubmitRef.current(),
  });

  const codingElapsedLabel =
    sessionPhase === "coding" && codingStartedAt !== null
      ? formatElapsedMs(codingNowTick - codingStartedAt)
      : null;

  const roundRemainingMs =
    roundStartTime !== null
      ? Math.max(0, ROUND_DURATION_MS - (roundNowTick - roundStartTime))
      : null;
  const roundCountdownLabel =
    roundRemainingMs !== null ? formatElapsedMs(roundRemainingMs) : null;
  const roundCountdownUrgency =
    roundRemainingMs !== null && roundRemainingMs <= 60_000
      ? "text-red-400"
      : roundRemainingMs !== null && roundRemainingMs <= 300_000
        ? "text-yellow-400"
        : "text-zinc-300";

  const phaseBudgetForHeader = PHASE_BUDGET_MS[sessionPhase];
  const phaseElapsedForHeader =
    phaseStartTime !== null ? Math.max(0, roundNowTick - phaseStartTime) : null;
  const showPhasePill =
    phaseElapsedForHeader !== null &&
    sessionPhase !== "feedback" &&
    sessionPhase !== "followUp";
  const phaseOverBudget =
    phaseBudgetForHeader !== null &&
    phaseElapsedForHeader !== null &&
    phaseElapsedForHeader > phaseBudgetForHeader;
  const phaseNearBudget =
    !phaseOverBudget &&
    phaseBudgetForHeader !== null &&
    phaseElapsedForHeader !== null &&
    phaseElapsedForHeader > phaseBudgetForHeader * 0.75;
  const phasePillClasses = phaseOverBudget
    ? "border-red-500/50 bg-red-500/10 text-red-300"
    : phaseNearBudget
      ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
      : "border-zinc-700 bg-zinc-800/60 text-zinc-300";
  const phasePillTitle =
    phaseBudgetForHeader !== null
      ? phaseOverBudget
        ? `Over ${phaseLabel(sessionPhase)} budget (~${Math.round(phaseBudgetForHeader / 60_000)}m) — move on soon`
        : `Suggested ${phaseLabel(sessionPhase)} budget ~${Math.round(phaseBudgetForHeader / 60_000)}m`
      : `${phaseLabel(sessionPhase)} phase`;

  if (sessionBoot === "pending") {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-300">
        <p className="text-sm text-zinc-400">Loading session…</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-zinc-950 text-zinc-100">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/90 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-100">
            {question.title}
          </p>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            {sessionPhase === "coding"
              ? "Ctrl+Enter run tests · Ctrl+D mark done"
              : sessionPhase === "followUp"
                ? "Follow-up questions — reply in chat, then continue to final feedback"
                : "\u00a0"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {showPhasePill && (
            <span
              className={`rounded-md border px-2 py-0.5 font-mono text-[11px] tabular-nums ${phasePillClasses}`}
              aria-label={`${phaseLabel(sessionPhase)} phase elapsed`}
              title={phasePillTitle}
            >
              {phaseLabel(sessionPhase)} {formatElapsedMs(phaseElapsedForHeader!)}
              {phaseOverBudget ? " · over" : ""}
            </span>
          )}
          {roundCountdownLabel !== null && (
            <span
              className={`font-mono text-sm tabular-nums ${roundCountdownUrgency}`}
              aria-label="Round time remaining"
              title="Time remaining in round"
            >
              {roundCountdownLabel}
            </span>
          )}
          {codingElapsedLabel !== null && roundCountdownLabel === null && (
            <span
              className="font-mono text-sm tabular-nums text-zinc-300"
              aria-label="Coding timer"
            >
              {codingElapsedLabel}
            </span>
          )}
          <button
            type="button"
            onClick={handleResetSession}
            disabled={isStreaming}
            className="rounded-md border border-zinc-600 bg-zinc-800/80 px-2.5 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Reset session
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div
          className={`flex min-h-0 min-w-0 flex-col transition-[width] duration-200 ease-out ${
            chatOpen ? "w-[65%] shrink-0 border-r border-zinc-800" : "w-full flex-1"
          }`}
        >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col">
              <Editor
                key={`${question.id}-${sessionResetKey}`}
                initialValue={editorInitialCode}
                readOnly={editorLocked}
                padRealism={padRealism && showEditorTools}
                onChange={(value) => {
                  codeRef.current = value;
                }}
              />
            {showEditorTools && (
              <>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-zinc-800 bg-zinc-900/80 px-3 py-2">
                  <span className="mr-auto text-[11px] text-zinc-500">
                    {runMode !== "dry-run"
                      ? "Run = visible self-check · Submit (in chat) = full evaluation"
                      : "Trace mode — no execution"}
                  </span>
                  <label className="flex items-center gap-1 text-[11px] text-zinc-500">
                    Mode:
                    <select
                      value={runMode}
                      onChange={(e) =>
                        setRunMode(
                          e.target.value as "standard" | "limited" | "dry-run"
                        )
                      }
                      className="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[11px] text-zinc-300 focus:outline-none"
                    >
                      <option value="standard">Standard</option>
                      <option value="limited">Limited (3 runs)</option>
                      <option value="dry-run">Dry-run</option>
                    </select>
                  </label>
                  {runMode !== "dry-run" && (
                    <button
                      type="button"
                      onClick={() => void handleRunTests()}
                      disabled={
                        testRunLoading ||
                        question.testCases.length === 0 ||
                        (runMode === "limited" && runCount >= MAX_LIMITED_RUNS) ||
                        runCount >= TEST_RUNS_MAX
                      }
                      title="Run the visible example tests only — a private self-check. Use Submit (in the chat panel) to be evaluated."
                      className="rounded-md border border-emerald-600/70 bg-emerald-950/40 px-3 py-1.5 text-sm font-medium text-emerald-100 transition hover:bg-emerald-900/50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {testRunLoading
                        ? "Running…"
                        : runMode === "limited"
                          ? `Run visible (${runCount}/${MAX_LIMITED_RUNS})`
                          : "Run visible tests"}
                    </button>
                  )}
                </div>
                {submitOutcome && (
                  <div className="shrink-0 border-t border-zinc-800 bg-amber-950/20 px-3 py-1.5 text-[11px] text-amber-200">
                    {submitOutcome} — hidden cases evaluated (their inputs stay hidden).
                  </div>
                )}
                {runMode === "dry-run" ? (
                  <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/60 px-3 py-2">
                    <p className="mb-1 text-[11px] text-zinc-500">
                      Trace table — step through your algorithm (variables, state changes):
                    </p>
                    <textarea
                      value={traceContent}
                      onChange={(e) => setTraceContent(e.target.value)}
                      placeholder="e.g.&#10;step=1, left=0, right=4, mid=2, nums[mid]=3&#10;step=2, left=3, right=4, mid=3, nums[mid]=5"
                      rows={5}
                      className="w-full resize-y rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
                    />
                  </div>
                ) : (
                  <ResizableTestResultsSection
                    results={testResults}
                    allPassed={testAllPassed}
                    loading={testRunLoading}
                    error={testRunError}
                  />
                )}
              </>
            )}
            </div>
          </div>
        </div>
        {chatOpen && (
          <div className="flex min-h-0 w-[35%] shrink-0 flex-col">
            <ChatPanel
              messages={messages}
              modelPresetId={modelPresetId}
              onModelPresetIdChange={setModelPresetId}
              utilityModelPresetId={utilityModelPresetId}
              onUtilityModelPresetIdChange={setUtilityModelPresetId}
              padRealism={padRealism}
              onPadRealismChange={setPadRealism}
              humanLatency={humanLatency}
              onHumanLatencyChange={setHumanLatency}
              onSendMessage={sendUserMessage}
              sessionPhase={sessionPhase}
              followUpSegment={followUpSegment}
              onSubmit={() => void handleSubmit()}
              onSkipToFinalFollowUp={() => void handleSkipToFinalFollowUp()}
              submitDisabled={
                sessionPhase === "coding" &&
                runMode === "dry-run" &&
                traceContent.trim().length === 0
              }
              submitDisabledReason="Fill in the trace table before submitting (dry-run mode)."
              onContinueToFeedback={() => void handleContinueToFeedback()}
              inputDisabled={isStreaming}
              speechSupported={speechSupported}
              whisperTranscribing={whisperTranscribing}
              backgroundListeningActive={
                sessionPhase === "coding" &&
                speechSupported &&
                !isStreaming
              }
              ambientTranscript={transcript}
              liveCaption={liveCaption}
              speechError={speechError}
              onDismissSpeechError={() => setSpeechError(null)}
              onMicPointerDown={handleMicPointerDown}
              onMicPointerUp={() => {
                void handleMicPointerUp();
              }}
              isStreaming={isStreaming}
              streamingAssistantId={streamingAssistantId}
              followUpSealed={followUpSealed}
              sliceGraceReply={sliceGraceReply}
              onOpenEditorPlanning={handleOpenEditorPlanning}
            />
          </div>
        )}
      </div>
      <ChatToggleButton chatOpen={chatOpen} onClick={() => setChatOpen((o) => !o)} />
    </div>
  );
}
