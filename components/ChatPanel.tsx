"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { AssistantMessageBody } from "@/components/AssistantMessageBody";
import { ByokDrawer } from "@/components/ByokDrawer";
import {
  AI_MODEL_OPTIONS,
  type AiModelPresetId,
} from "@/lib/ai-models";
import type {
  ChatMessage,
  FollowUpSegment,
  SessionPhase,
  TranscriptEntry,
} from "@/lib/chat";
import { synthesizeAlexVoice } from "@/lib/speech";

type Props = {
  messages: ChatMessage[];
  modelPresetId: AiModelPresetId;
  onModelPresetIdChange: (id: AiModelPresetId) => void;
  utilityModelPresetId: AiModelPresetId;
  onUtilityModelPresetIdChange: (id: AiModelPresetId) => void;
  padRealism: boolean;
  onPadRealismChange: (v: boolean) => void;
  humanLatency: boolean;
  onHumanLatencyChange: (v: boolean) => void;
  onSendMessage: (text: string) => void;
  sessionPhase: SessionPhase;
  /** Submit current code for evaluation — runs hidden cases, opens Alex's review. */
  onSubmit: () => void;
  /** When true, the Submit button is disabled (dry-run mode without a trace). */
  submitDisabled?: boolean;
  /** Reason text surfaced as tooltip / helper when submitDisabled is true. */
  submitDisabledReason?: string;
  followUpSegment?: FollowUpSegment;
  /** Candidate escape hatch — skip remaining variants and go to final Q&A. */
  onSkipToFinalFollowUp?: () => void;
  onContinueToFeedback: () => void;
  inputDisabled?: boolean;
  /** True while any AI stream is in progress (scroll follows streaming output). */
  isStreaming?: boolean;
  /**
   * Id of the assistant bubble for the single in-flight stream. Only this
   * bubble shows the "Alex is thinking" indicator, so stale empty bubbles from
   * earlier turns never appear live.
   */
  streamingAssistantId?: string | null;
  /** After capped follow-ups, input is sealed until final feedback. */
  followUpSealed?: boolean;
  /** Slice cap: one more reply allowed after the last interviewer question. */
  sliceGraceReply?: boolean;
  speechSupported: boolean;
  /** True while Groq Whisper is transcribing audio after mic release. */
  whisperTranscribing?: boolean;
  /** Coding phase: background dictation is intended to be running */
  backgroundListeningActive: boolean;
  /** Finalized lines from ambient listening (coding) */
  ambientTranscript: TranscriptEntry[];
  /** Latest interim speech-to-text (live preview) */
  liveCaption: string;
  speechError: string | null;
  onDismissSpeechError: () => void;
  onMicPointerDown: () => void;
  onMicPointerUp: () => void;
  /** Planning phase escape hatch — unlock editor if the AI released you without `[->coding]`. */
  onOpenEditorPlanning: () => void;
};

export function ChatPanel({
  messages,
  modelPresetId,
  onModelPresetIdChange,
  utilityModelPresetId,
  onUtilityModelPresetIdChange,
  padRealism,
  onPadRealismChange,
  humanLatency,
  onHumanLatencyChange,
  onSendMessage,
  sessionPhase,
  onSubmit,
  submitDisabled = false,
  submitDisabledReason,
  followUpSegment = "final",
  onSkipToFinalFollowUp,
  onContinueToFeedback,
  inputDisabled,
  isStreaming = false,
  streamingAssistantId = null,
  followUpSealed = false,
  sliceGraceReply = false,
  speechSupported,
  whisperTranscribing = false,
  backgroundListeningActive,
  ambientTranscript,
  liveCaption,
  speechError,
  onDismissSpeechError,
  onMicPointerDown,
  onMicPointerUp,
  onOpenEditorPlanning,
}: Props) {
  const [draft, setDraft] = useState("");
  const [micHeld, setMicHeld] = useState(false);
  const [byokOpen, setByokOpen] = useState(false);
  const [alexVoice, setAlexVoice] = useState<boolean>(() => {
    try {
      // Default ON for new visitors — voice is the demo's differentiator, so a
      // stranger should hear Alex without hunting for a toggle. Only an EXPLICIT
      // stored "false" (a user who turned it off) keeps it off; an absent value
      // (fresh browser) falls through to ON.
      return localStorage.getItem("ai-interviewer:alexVoice") !== "false";
    } catch {
      return true;
    }
  });
  const [ttsStatus, setTtsStatus] =
    useState<"idle" | "loading" | "playing">("idle");
  const [ttsError, setTtsError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const ttsRequestIdRef = useRef(0);
  const wasStreamingRef = useRef(false);
  const lastAutoVoiceMessageIdRef = useRef<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, ambientTranscript, liveCaption, isStreaming, followUpSealed]);

  useEffect(() => {
    try {
      localStorage.setItem("ai-interviewer:alexVoice", alexVoice ? "true" : "false");
    } catch {
      /* ignore */
    }
  }, [alexVoice]);

  useEffect(() => {
    return () => {
      ttsRequestIdRef.current += 1;
      audioRef.current?.pause();
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }
    };
  }, []);

  function cleanupAudio(): void {
    audioRef.current?.pause();
    audioRef.current = null;
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }

  function stopAlexVoice(): void {
    ttsRequestIdRef.current += 1;
    cleanupAudio();
    setTtsStatus("idle");
  }

  function getLatestAssistantMessage(): ChatMessage | null {
    return (
      [...messages]
        .reverse()
        .find((m) => m.role === "assistant" && m.content.trim().length > 0) ??
      null
    );
  }

  function shouldAutoSpeakMessage(): boolean {
    // Speak every interviewer turn aloud — only the written feedback report
    // (a long, read-not-heard document) is left for the user to read.
    return sessionPhase !== "feedback";
  }

  function handleAlexVoiceChange(enabled: boolean): void {
    setAlexVoice(enabled);
    if (!enabled) {
      stopAlexVoice();
      return;
    }

    const latestAssistant = getLatestAssistantMessage();
    if (latestAssistant && shouldAutoSpeakMessage()) {
      lastAutoVoiceMessageIdRef.current = latestAssistant.id;
      void speakAssistantMessage(latestAssistant.content, "manual");
    }
  }

  async function speakAssistantMessage(
    text: string,
    trigger: "auto" | "manual"
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const requestId = ttsRequestIdRef.current + 1;
    ttsRequestIdRef.current = requestId;
    cleanupAudio();
    setTtsError(null);
    setTtsStatus("loading");
    try {
      const blob = await synthesizeAlexVoice(trimmed);
      if (ttsRequestIdRef.current !== requestId) {
        return;
      }
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audioUrlRef.current = url;
      audio.onended = () => {
        if (ttsRequestIdRef.current === requestId) {
          cleanupAudio();
          setTtsStatus("idle");
        }
      };
      audio.onerror = () => {
        if (ttsRequestIdRef.current === requestId) {
          cleanupAudio();
          setTtsStatus("idle");
          setTtsError("Could not play ElevenLabs audio.");
        }
      };
      await audio.play();
      if (ttsRequestIdRef.current === requestId) {
        setTtsStatus("playing");
      }
    } catch (e) {
      if (ttsRequestIdRef.current !== requestId) {
        return;
      }
      cleanupAudio();
      setTtsStatus("idle");
      const errText = e instanceof Error ? e.message : String(e);
      setTtsError(
        trigger === "auto" && /play/i.test(errText)
          ? "Browser blocked autoplay. Click Speak on any Alex message once, then auto voice can continue."
          : errText
      );
    }
  }

  useEffect(() => {
    const justFinishedStreaming = wasStreamingRef.current && !isStreaming;
    wasStreamingRef.current = isStreaming;
    if (!justFinishedStreaming || !alexVoice || sessionPhase === "feedback") {
      return;
    }
    const latestAssistant = getLatestAssistantMessage();
    if (
      !latestAssistant ||
      latestAssistant.id === lastAutoVoiceMessageIdRef.current ||
      !shouldAutoSpeakMessage()
    ) {
      return;
    }
    lastAutoVoiceMessageIdRef.current = latestAssistant.id;
    void speakAssistantMessage(latestAssistant.content, "auto");
    // speakAssistantMessage intentionally reads refs/state directly for playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alexVoice, isStreaming, messages, sessionPhase]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (inputDisabled) return;
    if (sessionPhase === "feedback") return;
    if (sessionPhase === "followUp" && followUpSealed && !sliceGraceReply) {
      return;
    }
    const text = draft.trim();
    if (!text) return;
    onSendMessage(text);
    setDraft("");
  }

  const followUpInputSealed =
    sessionPhase === "followUp" && followUpSealed && !sliceGraceReply;
  const chatLocked =
    sessionPhase === "feedback" || inputDisabled || followUpInputSealed;
  const showMic =
    speechSupported &&
    !whisperTranscribing &&
    sessionPhase !== "feedback" &&
    !followUpInputSealed;
  const showAmbientIndicator =
    backgroundListeningActive && !micHeld && sessionPhase === "coding";

  return (
    <aside className="flex h-full min-h-0 flex-1 flex-col bg-zinc-950">
      <div className="shrink-0 border-b border-zinc-800 px-4 py-3">
        {byokOpen && <ByokDrawer onClose={() => setByokOpen(false)} />}
        <div className="flex flex-col gap-2">
          {/* Row 1: name + BYOK | phase subtitle */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-zinc-100">Alex</h2>
              <button
                type="button"
                onClick={() => setByokOpen(true)}
                className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                title="Bring Your Own Key — set per-provider API keys"
              >
                API Keys
              </button>
            </div>
            <p className="text-[11px] text-zinc-500">
              {sessionPhase === "followUp"
                ? followUpSegment === "slice"
                  ? sliceGraceReply
                    ? "Reply to Alex, or continue below when ready"
                    : followUpSealed
                      ? "Review complete — continue below"
                      : "Discuss this implementation (one question at a time)"
                  : followUpSealed
                    ? "Follow-ups complete — continue below for written feedback"
                    : "Final follow-up questions (one at a time)"
                : sessionPhase === "feedback"
                  ? "Structured feedback"
                  : "Chat & transcript will appear here"}
            </p>
          </div>

          {/* Row 2: model pickers */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex shrink-0 flex-col gap-0.5">
              <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Interviewer
              </span>
              <select
                value={modelPresetId}
                onChange={(e) =>
                  onModelPresetIdChange(e.target.value as AiModelPresetId)
                }
                disabled={inputDisabled}
                className="max-w-44 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Interviewer AI model"
              >
                {AI_MODEL_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex shrink-0 flex-col gap-0.5">
              <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Utility
              </span>
              <select
                value={utilityModelPresetId}
                onChange={(e) =>
                  onUtilityModelPresetIdChange(e.target.value as AiModelPresetId)
                }
                disabled={inputDisabled}
                className="max-w-44 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Utility AI model (openers, closers, summaries)"
              >
                {AI_MODEL_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Row 3: checkboxes */}
          <div className="flex gap-4">
            <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-400">
              <input
                type="checkbox"
                checked={padRealism}
                onChange={(e) => onPadRealismChange(e.target.checked)}
                disabled={inputDisabled}
                className="accent-emerald-500"
              />
              Pad realism
            </label>
            <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-400">
              <input
                type="checkbox"
                checked={humanLatency}
                onChange={(e) => onHumanLatencyChange(e.target.checked)}
                disabled={inputDisabled}
                className="accent-emerald-500"
              />
              Human latency
            </label>
            <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-400">
              <input
                type="checkbox"
                checked={alexVoice}
                onChange={(e) => handleAlexVoiceChange(e.target.checked)}
                disabled={inputDisabled}
                className="accent-emerald-500"
              />
              Alex voice
            </label>
            {ttsStatus !== "idle" && (
              <button
                type="button"
                onClick={stopAlexVoice}
                className="text-[11px] text-zinc-500 hover:text-zinc-300"
              >
                {ttsStatus === "loading" ? "Cancel voice" : "Stop voice"}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="text-sm text-zinc-500">Preparing your session…</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((m) => (
              <li
                key={m.id}
                className={
                  m.role === "user"
                    ? "flex justify-end"
                    : "flex justify-start"
                }
              >
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[min(100%,85%)] whitespace-pre-wrap rounded-lg rounded-br-sm bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
                      : "max-w-[min(100%,85%)] rounded-lg rounded-bl-sm border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-200"
                  }
                >
                  {m.role === "user" ? (
                    m.content
                  ) : m.content.length === 0 && m.id === streamingAssistantId ? (
                    <span
                      className="flex items-center gap-1.5 text-zinc-400"
                      role="status"
                      aria-label={
                        sessionPhase === "feedback"
                          ? "Generating feedback"
                          : "Alex is thinking"
                      }
                    >
                      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-500" />
                      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-500 [animation-delay:150ms]" />
                      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-500 [animation-delay:300ms]" />
                      <span className="ml-1.5 text-[11px] italic text-zinc-500">
                        {sessionPhase === "feedback"
                          ? "Generating feedback…"
                          : "Alex is thinking…"}
                      </span>
                    </span>
                  ) : (
                    <>
                      <AssistantMessageBody content={m.content} />
                      <div className="mt-2 flex justify-end">
                        <button
                          type="button"
                          onClick={() =>
                            void speakAssistantMessage(m.content, "manual")
                          }
                          disabled={ttsStatus === "loading"}
                          className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-500 transition hover:border-zinc-500 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Speak
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {sessionPhase === "coding" && speechSupported && (
          <div className="mt-4 border-t border-zinc-800 pt-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Your voice (thinking aloud)
            </p>
            <p className="mt-1 text-[11px] text-zinc-600">
              Captured in ~30s chunks via Groq Whisper. Shown here for your
              reference; the interviewer only sees chat messages you send or
              dictate with the mic button.
            </p>
            {ambientTranscript.length === 0 && liveCaption.length === 0 && (
              <p className="mt-3 text-sm leading-relaxed text-zinc-500">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500/70 animate-pulse align-middle mr-2"
                  aria-hidden
                />
                Listening… first chunk transcribes after ~30s.
              </p>
            )}
            {ambientTranscript.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1.5 text-sm text-zinc-300">
                {ambientTranscript.map((e, i) => (
                  <li
                    key={`${e.timestamp}-${i}`}
                    className="whitespace-pre-wrap"
                  >
                    {e.text}
                  </li>
                ))}
              </ul>
            )}
            {liveCaption.length > 0 && (
              <p className="mt-2 border-l-2 border-emerald-600/60 pl-2 text-sm italic text-zinc-400">
                {liveCaption}
              </p>
            )}
          </div>
        )}

        <div ref={bottomRef} aria-hidden className="h-px shrink-0" />
      </div>

      <div className="shrink-0 space-y-2 border-t border-zinc-800 p-3 pr-14">
        {ttsError && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-900/80 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
            <p className="min-w-0 flex-1 leading-snug">
              ElevenLabs voice: {ttsError}
            </p>
            <button
              type="button"
              onClick={() => setTtsError(null)}
              className="shrink-0 rounded px-2 py-0.5 text-amber-200 hover:bg-amber-900/50"
            >
              Dismiss
            </button>
          </div>
        )}
        {speechError && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-900/80 bg-rose-950/50 px-3 py-2 text-xs text-rose-100">
            <p className="min-w-0 flex-1 leading-snug">{speechError}</p>
            <button
              type="button"
              onClick={onDismissSpeechError}
              className="shrink-0 rounded px-2 py-0.5 text-rose-200 hover:bg-rose-900/50"
            >
              Dismiss
            </button>
          </div>
        )}
        {showAmbientIndicator && (
          <div className="flex items-center gap-2 px-0.5 text-xs text-zinc-500">
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500/80 animate-pulse"
              aria-hidden
            />
            <span>
              Groq Whisper listening — transcribed in 30s chunks
            </span>
          </div>
        )}
        {whisperTranscribing && (
          <div
            className="rounded-md border border-amber-500/50 bg-amber-950/30 px-2 py-1.5 text-center text-xs font-medium text-amber-100"
            role="status"
          >
            Transcribing via Groq Whisper…
          </div>
        )}
        {micHeld && (
          <div
            className="rounded-md border border-sky-500/60 bg-sky-950/40 px-2 py-1.5 text-center text-xs font-medium text-sky-200"
            role="status"
          >
            <p>Hold to record — release to transcribe</p>
            {liveCaption.length > 0 && (
              <p className="mt-1 text-left font-normal text-sky-100/90">
                {liveCaption}
              </p>
            )}
          </div>
        )}

        {sessionPhase === "planning" && (
          <button
            type="button"
            onClick={onOpenEditorPlanning}
            disabled={
              chatLocked ||
              isStreaming ||
              inputDisabled ||
              whisperTranscribing
            }
            title="Unlock the editor if Alex already told you to start coding."
            className="w-full rounded-lg border border-emerald-700/70 bg-emerald-950/40 px-4 py-2.5 text-sm font-medium text-emerald-50 transition hover:border-emerald-500 hover:bg-emerald-900/50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Open editor — start coding
          </button>
        )}
        {sessionPhase === "coding" && (
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={onSubmit}
              disabled={chatLocked || submitDisabled}
              title={
                submitDisabled
                  ? submitDisabledReason
                  : "Submit for evaluation — runs the hidden tests and has Alex review your solution"
              }
              className="w-full rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition enabled:hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Submit for review
            </button>
            {onSkipToFinalFollowUp && (
              <button
                type="button"
                onClick={onSkipToFinalFollowUp}
                disabled={chatLocked || submitDisabled}
                className="w-full rounded-lg border border-zinc-600 bg-zinc-900/80 px-4 py-2 text-sm font-medium text-zinc-200 transition enabled:hover:border-zinc-500 enabled:hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Skip to final Q&amp;A
              </button>
            )}
            <p className="text-[11px] text-zinc-500">
              Run (above the editor) self-checks the visible examples. Submit runs
              the hidden tests and hands your solution to Alex to review, then he
              moves you on.
            </p>
            {submitDisabled && submitDisabledReason && (
              <p className="text-[11px] text-amber-400/80">{submitDisabledReason}</p>
            )}
          </div>
        )}
        {sessionPhase === "followUp" && followUpSegment === "slice" && (
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={onSubmit}
              disabled={inputDisabled || submitDisabled}
              title="Edit your code and re-submit it for evaluation"
              className="w-full rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition enabled:hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Submit again
            </button>
            {onSkipToFinalFollowUp && (
              <button
                type="button"
                onClick={onSkipToFinalFollowUp}
                disabled={inputDisabled}
                className="w-full rounded-lg border border-zinc-600 bg-zinc-900/80 px-4 py-2 text-sm font-medium text-zinc-200 transition enabled:hover:border-zinc-500 enabled:hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Skip to final Q&amp;A
              </button>
            )}
            <p className="text-[11px] text-zinc-500">
              Reply to Alex, or edit your code and Submit again to re-evaluate. Alex
              moves you on when the review wraps.
            </p>
          </div>
        )}
        {sessionPhase === "followUp" && followUpSegment === "final" && (
          <button
            type="button"
            onClick={onContinueToFeedback}
            disabled={chatLocked}
            className="w-full rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Continue to final feedback
          </button>
        )}

        <form onSubmit={handleSubmit}>
          <div className="flex gap-2">
            {showMic && (
              <button
                type="button"
                disabled={chatLocked}
                aria-label={
                  sessionPhase === "coding"
                    ? "Hold for voice question (pauses ambient listening)"
                    : "Hold to dictate a message"
                }
                aria-pressed={micHeld}
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border text-zinc-100 transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  micHeld
                    ? "border-sky-400 bg-sky-900/50 ring-2 ring-sky-400 ring-offset-2 ring-offset-zinc-950"
                    : "border-zinc-600 bg-zinc-800 enabled:hover:border-zinc-500 enabled:hover:bg-zinc-700"
                }`}
                onPointerDown={(e) => {
                  if (chatLocked) return;
                  e.preventDefault();
                  setMicHeld(true);
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {
                    /* ignore */
                  }
                  onMicPointerDown();
                }}
                onPointerUp={(e) => {
                  setMicHeld(false);
                  onMicPointerUp();
                  try {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  } catch {
                    /* ignore */
                  }
                }}
                onPointerCancel={() => {
                  setMicHeld(false);
                  onMicPointerUp();
                }}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="h-5 w-5"
                  aria-hidden
                >
                  <path d="M8.25 4.5a3.75 3.75 0 0 1 7.5 0v8.25a3.75 3.75 0 1 1-7.5 0V4.5Z" />
                  <path d="M6 10.5a.75.75 0 0 1 .75.75v.75a5.25 5.25 0 1 0 10.5 0v-.75a.75.75 0 0 1 1.5 0v.75a6.751 6.751 0 0 1-6 6.709v2.291h3a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0-1.5h3v-2.291a6.751 6.751 0 0 1-6-6.709v-.75A.75.75 0 0 1 6 10.5Z" />
                </svg>
              </button>
            )}
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                sessionPhase === "feedback"
                  ? "Feedback complete"
                  : sessionPhase === "followUp"
                    ? sliceGraceReply
                      ? "Reply to Alex…"
                      : followUpInputSealed
                        ? "Follow-ups finished"
                        : "Answer the interviewer…"
                    : "Message…"
              }
              className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              autoComplete="off"
              aria-label="Message"
              disabled={chatLocked}
            />
            <button
              type="submit"
              disabled={!draft.trim() || chatLocked}
              className="shrink-0 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 transition enabled:hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </aside>
  );
}
