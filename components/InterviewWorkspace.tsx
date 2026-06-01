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
import { FOLLOW_UP_SAFETY_CAP, ROUND_DURATION_MS } from "@/lib/interview-limits";
import type { FollowUpSegment } from "@/lib/chat";
import type { PaceReport } from "@/lib/feedback";
import { PHASE_BUDGET_MS } from "@/lib/phase-config";
import { getRoundThresholds } from "@/lib/round-config";
import {
  questionToEditorInitialValue,
  questionToProblemStatement,
  type Question,
} from "@/lib/questions";
import { assistantInvitesCodingWithoutToken } from "@/lib/planning-coding-invite";
import { buildCodingVoiceReport } from "@/lib/coding-voice-report";
import {
  buildBankedEscalationHint,
  getPendingBankedFollowUp,
} from "@/lib/coding-escalation";

type Props = {
  question: Question;
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
  // Set when tests pass while a stream is still in flight; the slice follow-up
  // opener is retried once that stream finishes (see isStreaming effect).
  const pendingSliceFollowUpRef = useRef(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [liveCaption, setLiveCaption] = useState("");
  const [speechError, setSpeechError] = useState<string | null>(null);
  const focusMic = useFocusMicRecorder();
  const whisperTranscribing = focusMic.transcribing;
  const [testRunLoading, setTestRunLoading] = useState(false);
  const [testRunError, setTestRunError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<TestResult[] | null>(null);
  const [testAllPassed, setTestAllPassed] = useState<boolean | null>(null);
  const lastTestResultRef = useRef<TestRunSummary | null>(null);
  const pendingHiddenNudgeRef = useRef<string | null>(null);
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
  const handleImDoneRef = useRef(() => {});
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
  const baselineSolvedAtRef = useRef<number | null>(null);
  const [baselineSolvedAt, setBaselineSolvedAt] = useState<number | null>(null);
  const codingEscalationStepRef = useRef(0);
  const escalationNudgeGenRef = useRef(0);
  // Cutoff for the ambient-tail merge: every typed/voice user message includes
  // ambient transcript captured AFTER this timestamp (and within a short window),
  // then advances the cutoff so the same lines aren't sent twice.
  const lastSentAmbientCutoffRef = useRef<number>(0);
  // When tests pass during coding, we drain queued HINT(s) into here and the
  // proactive nudge runner consumes them. Treated as a single bundled HINT.
  const pendingProactiveEscalationHintRef = useRef<string | null>(null);
  // Tracks which kind of increment the proactive nudge should perform on success.
  const pendingProactiveBankedRef = useRef(false);
  const pendingProactiveAutonomousRef = useRef(false);
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

  const remainingRoundMs = useMemo(() => {
    if (roundStartTime === null) {
      return ROUND_DURATION_MS;
    }
    return Math.max(0, ROUND_DURATION_MS - (roundNowTick - roundStartTime));
  }, [roundStartTime, roundNowTick]);

  const pendingBankedEscalation = useMemo(
    () =>
      getPendingBankedFollowUp(
        question.followUps,
        currentFollowUpIndex,
        baselineSolvedAt,
        remainingRoundMs
      ),
    [
      question.followUps,
      currentFollowUpIndex,
      baselineSolvedAt,
      remainingRoundMs,
    ]
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
      setBaselineSolvedAt(saved.baselineSolvedAt);
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

  // Retry the deferred slice follow-up opener once any in-flight stream ends.
  // handleRunTests sets pendingSliceFollowUpRef when tests pass mid-stream
  // instead of dropping the transition.
  useEffect(() => {
    if (!isStreaming && pendingSliceFollowUpRef.current) {
      pendingSliceFollowUpRef.current = false;
      const alreadySlice =
        sessionPhaseRef.current === "followUp" &&
        followUpSegmentRef.current === "slice";
      if (!alreadySlice) {
        void enterSliceFollowUpPhase();
      }
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
    // Precedence: this beats the verbal wrap trigger — hand off immediately.
    if (
      phase === "coding" &&
      !forcedHandoffScheduledRef.current &&
      remaining > 0 &&
      remaining <= ROUND_THRESHOLDS.followUpFloorMs
    ) {
      forcedHandoffScheduledRef.current = true;
      queueMicrotask(() => handleImDoneRef.current());
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
    question.interviewerContext,
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

  function filterBlankAssistantMessages(messagesForApi: ChatMessage[]): ChatMessage[] {
    return messagesForApi.filter(
      (m) => !(m.role === "assistant" && m.content.trim() === "")
    );
  }

  function buildTestRunSummary(result: RunCodeResult): TestRunSummary {
    return {
      visiblePassed: result.passed,
      hiddenPassed: result.hiddenPassed,
      passedCount:
        result.results.filter((r) => r.passed).length +
        result.hiddenResults.filter((r) => r.passed).length,
      failedCount:
        result.results.filter((r) => !r.passed).length +
        result.hiddenResults.filter((r) => !r.passed).length,
      hiddenFailedCount: result.hiddenResults.filter((r) => !r.passed).length,
      cases: [
        ...result.results.map((r) => ({ ...r, hidden: false })),
        ...result.hiddenResults.map((r) => ({ ...r, hidden: true })),
      ],
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
        interviewerContext: question.interviewerContext,
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
    const pending = getPendingBankedFollowUp(
      question.followUps,
      currentFollowUpIndexRef.current,
      baselineSolvedAtRef.current,
      getRemainingRoundMsNow()
    );
    if (pending === null) {
      return false;
    }
    const nextIndex = pending.index + 1;
    currentFollowUpIndexRef.current = nextIndex;
    setCurrentFollowUpIndex(nextIndex);
    pendingProactiveEscalationHintRef.current = buildBankedEscalationHint(
      pending.followUp
    );
    pendingProactiveBankedRef.current = true;
    pendingProactiveAutonomousRef.current = false;
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
    const wasAutonomous = pendingProactiveAutonomousRef.current;
    pendingProactiveBankedRef.current = false;
    pendingProactiveAutonomousRef.current = false;

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
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + chunk } : m
          )
        );
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
        finalizeAssistantMessage(assistantId);
        pauseBgForAiRef.current = false;
        if (streamOk) {
          codingEscalationStepRef.current += 1;
          if (wasBanked) {
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
          // Autonomous-only path: nothing else to track beyond the step bump.
          void wasAutonomous;
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
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + chunk } : m
          )
        );
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
        finalizeAssistantMessage(assistantId);
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
    if (phaseNow === "coding") {
      lastSentAmbientCutoffRef.current = now;
    }
    try {
      pendingHiddenNudgeRef.current = null;
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
      finalizeAssistantMessage(assistantId);
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
        if (outOfTime || hitSafety) {
          if (sliceSegment) {
            if (sliceForceWrapUpRef.current) {
              sliceForceWrapUpRef.current = false;
              sliceAwaitingCandidateReplyRef.current = false;
              setSliceGraceReply(false);
              followUpSealedRef.current = true;
              setFollowUpSealed(true);
            } else if (!sliceAwaitingCandidateReplyRef.current) {
              sliceAwaitingCandidateReplyRef.current = true;
              setSliceGraceReply(true);
            } else {
              sliceAwaitingCandidateReplyRef.current = false;
              setSliceGraceReply(false);
              followUpSealedRef.current = true;
              setFollowUpSealed(true);
            }
          }
          // Non-slice cap/time hit: the model gives a verbal close from the
          // followUp prompt; feedback itself is app-driven (Continue / round
          // backstop), so the app does not auto-close here.
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

  async function enterSliceFollowUpPhase(): Promise<void> {
    if (
      sessionPhaseRef.current === "followUp" &&
      followUpSegmentRef.current === "slice"
    ) {
      return;
    }
    if (isStreamingRef.current) {
      return;
    }

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

    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "" },
    ]);
    markStreamStart(assistantId);
    currentAgentAssistantIdRef.current = assistantId;

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
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + chunk } : m
          )
        );
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
        finalizeAssistantMessage(assistantId);
        followUpAssistantTurnsRef.current = 1;
      }
    }
  }

  async function enterFinalFollowUpPhase(): Promise<void> {
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
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + chunk } : m
          )
        );
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
        finalizeAssistantMessage(assistantId);
        followUpAssistantTurnsRef.current = 1;
      }
    }
  }

  async function proceedFromSliceToCoding(): Promise<void> {
    if (isStreaming) {
      return;
    }

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

    if (tryScheduleBankedCodingEscalation()) {
      return;
    }

    const remainingMs = getRemainingRoundMsNow();
    const autonomousThresholdMs =
      ROUND_THRESHOLDS.forcedStopTriggerMs + 3 * 60_000;
    if (
      baselineSolvedAtRef.current !== null &&
      remainingMs > autonomousThresholdMs
    ) {
      const minutesLeft = Math.round(remainingMs / 60_000);
      pendingProactiveEscalationHintRef.current = `Autonomous escalation unlocked: roughly ${minutesLeft} min remain. Propose ONE concrete escalation in the same problem family and ask them to implement it in the editor (update code, run tests). One ask, then wait.`;
      pendingProactiveBankedRef.current = false;
      pendingProactiveAutonomousRef.current = true;
      await runCodingEscalationNudge();
      return;
    }

    await enterFinalFollowUpPhase();
  }

  async function handleImDone() {
    if (isStreaming || sessionPhase !== "coding") {
      return;
    }
    if (runMode === "dry-run" && traceContent.trim().length === 0) {
      return;
    }

    await enterSliceFollowUpPhase();
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

  async function handleProceedFromSlice() {
    if (
      isStreaming ||
      sessionPhase !== "followUp" ||
      followUpSegment !== "slice"
    ) {
      return;
    }
    await proceedFromSliceToCoding();
  }

  async function handleSliceToFinalQuestions() {
    if (isStreaming || sessionPhase !== "followUp") {
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

  async function handleRunTests() {
    if (forcedWrapRef.current) {
      // Editor locked for verbal wrap-up — no further runs accepted.
      return;
    }
    if (!codeRef.current.trim()) {
      setTestRunError("Add code before running tests.");
      lastTestResultRef.current = null;
      setTestResults(null);
      setTestAllPassed(null);
      return;
    }
    if (runMode === "limited" && runCountRef.current >= MAX_LIMITED_RUNS) {
      setTestRunError(`Run limit reached (${MAX_LIMITED_RUNS} runs used).`);
      return;
    }
    if (runMode === "dry-run") {
      return; // button is hidden in dry-run mode
    }
    if (runMode === "limited") {
      const next = runCountRef.current + 1;
      runCountRef.current = next;
      setRunCount(next);
    }
    setTestRunLoading(true);
    setTestRunError(null);
    try {
      const res = await fetch("/api/judge0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: codeRef.current,
          testCases: question.testCases,
          hiddenTestCases: question.hiddenTestCases ?? [],
          entryFunction: question.entryFunction,
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
        lastTestResultRef.current = null;
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
        lastTestResultRef.current = null;
        setTestResults(null);
        setTestAllPassed(null);
        return;
      }
      const runResult = data as RunCodeResult;
      const { passed, results, hiddenPassed, hiddenResults } = runResult;
      lastTestResultRef.current = buildTestRunSummary(runResult);
      setTestResults(results);
      setTestAllPassed(passed);

      // First-ever test run: detect "brute-force skipped" — candidate's first
      // submitted code passes every visible and hidden case without an
      // observed brute-force → optimal arc. Feeds the pace report.
      if (!firstTestRunConsumedRef.current) {
        firstTestRunConsumedRef.current = true;
        if (passed && hiddenPassed) {
          bruteForceSkippedRef.current = true;
        }
      }

      const queuedNudges: string[] = [];

      // Progressive escalation: fire when visible tests pass during coding.
      // We pick the strongest available HINT (banked > autonomous) and fire a
      // PROACTIVE interviewer message right away — no need to wait for the
      // candidate to type something. Forced-wrap mode short-circuits the whole
      // thing (we're about to hand off, no point in escalating).
      if (
        passed &&
        sessionPhaseRef.current === "coding" &&
        !forcedWrapRef.current
      ) {
        const now = Date.now();
        if (baselineSolvedAtRef.current === null) {
          baselineSolvedAtRef.current = now;
          setBaselineSolvedAt(now);
        }

        // If a stream is still in flight (e.g. a proactive nudge), defer the
        // slice opener instead of dropping it — the isStreaming effect retries
        // it once the stream ends.
        if (isStreamingRef.current) {
          pendingSliceFollowUpRef.current = true;
        } else {
          queueMicrotask(() => {
            void enterSliceFollowUpPhase();
          });
        }
      }

      // If any hidden tests failed, append (do not overwrite) a nudge.
      if (!hiddenPassed && hiddenResults.length > 0) {
        const failedCases = hiddenResults.filter((r) => !r.passed);
        const descriptions = (question.hiddenTestCases ?? [])
          .filter((_, i) => i < hiddenResults.length && !hiddenResults[i].passed)
          .map((tc) => tc.description)
          .filter((d): d is string => typeof d === "string");
        const summary =
          descriptions.length > 0
            ? descriptions.join("; ")
            : `${failedCases.length} hidden edge-case${failedCases.length !== 1 ? "s" : ""}`;
        queuedNudges.push(
          `Candidate's code failed hidden test case(s): ${summary}.`
        );
      }

      if (queuedNudges.length > 0) {
        pendingHiddenNudgeRef.current = [
          ...(pendingHiddenNudgeRef.current ? [pendingHiddenNudgeRef.current] : []),
          ...queuedNudges,
        ].join(" ");
      }
    } catch (e) {
      setTestRunError(e instanceof Error ? e.message : String(e));
      lastTestResultRef.current = null;
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
    pendingHiddenNudgeRef.current = null;
    pendingProactiveEscalationHintRef.current = null;
    pendingProactiveBankedRef.current = false;
    pendingProactiveAutonomousRef.current = false;
    pendingSliceFollowUpRef.current = false;
    streamingAssistantIdRef.current = null;
    setStreamingAssistantId(null);
    escalationNudgeGenRef.current += 1;
    lastSentAmbientCutoffRef.current = 0;
    bruteForceSkippedRef.current = false;
    firstTestRunConsumedRef.current = false;
    followUpAutoCloseByTimeCheckedRef.current = false;
    baselineSolvedAtRef.current = null;
    setBaselineSolvedAt(null);
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
  handleImDoneRef.current = () => {
    void handleImDone();
  };

  useCodingShortcuts({
    sessionPhaseRef,
    testRunLoadingRef,
    isStreamingRef,
    onRunTests: () => handleRunTestsRef.current(),
    onImDone: () => handleImDoneRef.current(),
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
                    {runMode !== "dry-run" ? "Ctrl+Enter" : "Trace mode — no execution"}
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
                        (runMode === "limited" && runCount >= MAX_LIMITED_RUNS)
                      }
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {testRunLoading
                        ? "Running…"
                        : runMode === "limited"
                          ? `Run tests (${runCount}/${MAX_LIMITED_RUNS})`
                          : "Run tests"}
                    </button>
                  )}
                </div>
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
              hasPendingBankedVariant={pendingBankedEscalation !== null}
              onImDone={() => void handleImDone()}
              onSkipToFinalFollowUp={() => void handleSkipToFinalFollowUp()}
              onProceedFromSlice={() => void handleProceedFromSlice()}
              onSliceToFinalQuestions={() => void handleSliceToFinalQuestions()}
              imDoneDisabled={
                sessionPhase === "coding" &&
                runMode === "dry-run" &&
                traceContent.trim().length === 0
              }
              imDoneDisabledReason="Fill in the trace table before marking done (dry-run mode)."
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
