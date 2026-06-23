// The single interviewer brain (POST /api/interviewer). Handles every
// conversational turn — opening, clarifying, planning, coding guidance,
// escalations, follow-ups, nudges — from one system prompt plus live state.
// Built on Vercel AI SDK 6 streamText with grounding-only tool calling.
// Phase is app metadata (the model signals readiness with inline tokens; the
// client commits). The written scorecard is a separate grounded generation
// (POST /api/feedback). Default model is OpenAI GPT-5.4 Mini (the hosted demo
// runs on the builder's own key); any preset works via BYOK.

import { randomUUID } from "node:crypto";

import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
} from "ai";
import { NextResponse, type NextRequest } from "next/server";

import { isInsufficientQuotaError } from "@/lib/ai-errors";
import {
  DEFAULT_AI_MODEL_PRESET_ID,
  getAiModelConfig,
} from "@/lib/ai-models";
import { getByokMode, setByokMode } from "@/lib/byok-mode";
import type { ChatMessage, TranscriptEntry } from "@/lib/chat";
import { INTERVIEWER_MAX_OUTPUT_TOKENS } from "@/lib/interview-limits";
import { getInterviewerLanguageModel } from "@/lib/interviewer-model";
import {
  buildContextMessages,
  buildSystemPrompt,
} from "@/lib/interviewer-prompt";
import { buildTools } from "@/lib/interviewer-tools";
import { getQuestionById } from "@/lib/questions";
import {
  keyMatchesProvider,
  MissingProviderKeyError,
  resolveProviderKey,
} from "@/lib/resolve-provider-key";
import type { SessionState } from "@/lib/session-state";
import { incrementStat } from "@/lib/stats";

export const runtime = "nodejs";

type InterviewerRequestBody = {
  sessionState: SessionState;
  messages: ChatMessage[];
  transcript: TranscriptEntry[];
  turnCount: number;
  modelPresetId?: string;
};

// Hard caps on attacker-controllable payload fields, enforced before any
// external (model) call so an oversized body can't run up cost or memory. EVERY
// client string that lands in the system prompt is bounded here — not just the
// obvious code/transcript blobs but the question text, follow-up prompts,
// app-control hints, phase/segment markers, and probed-topic labels.
const MAX_CHAT_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 8000;
const MAX_CODE_CHARS = 15000;
const MAX_TRANSCRIPT_CHARS = 50000;
const MAX_SNAPSHOTS = 20;
const MAX_SNAPSHOT_CHARS = 5000;
const MAX_QUESTION_CHARS = 20000;
const MAX_PROMPT_FIELD_CHARS = 8000;
const MAX_TOPICS = 100;

function payloadTooLarge(): NextResponse {
  return NextResponse.json({ error: "payload_too_large" }, { status: 400 });
}

/** True when `value` is a string longer than `max`. Non-strings never exceed. */
function strExceeds(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length > max;
}

/** Returns a 400 response if the request body exceeds size limits, else null. */
function validatePayloadSize(body: InterviewerRequestBody): NextResponse | null {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length > MAX_CHAT_MESSAGES) {
    return payloadTooLarge();
  }
  for (const m of messages) {
    if (strExceeds(m?.content, MAX_MESSAGE_CHARS)) {
      return payloadTooLarge();
    }
  }

  const transcript = Array.isArray(body.transcript) ? body.transcript : [];
  let transcriptChars = 0;
  for (const entry of transcript) {
    if (typeof entry?.text === "string") {
      transcriptChars += entry.text.length;
    }
  }
  if (transcriptChars > MAX_TRANSCRIPT_CHARS) {
    return payloadTooLarge();
  }

  const state = body.sessionState;
  if (strExceeds(state?.currentCode, MAX_CODE_CHARS)) {
    return payloadTooLarge();
  }

  const snapshots = Array.isArray(state?.snapshots) ? state.snapshots : [];
  if (snapshots.length > MAX_SNAPSHOTS) {
    return payloadTooLarge();
  }
  for (const snap of snapshots) {
    if (
      strExceeds(snap?.code, MAX_SNAPSHOT_CHARS) ||
      strExceeds(snap?.transcript, MAX_SNAPSHOT_CHARS)
    ) {
      return payloadTooLarge();
    }
  }

  // Every remaining client string that the system prompt interpolates.
  const question = state?.question;
  if (
    strExceeds(question?.title, MAX_PROMPT_FIELD_CHARS) ||
    strExceeds(question?.candidateDescription, MAX_QUESTION_CHARS)
  ) {
    return payloadTooLarge();
  }

  const activeFollowUp = state?.activeFollowUp;
  if (
    strExceeds(activeFollowUp?.prompt, MAX_PROMPT_FIELD_CHARS) ||
    strExceeds(activeFollowUp?.entryFunction, MAX_PROMPT_FIELD_CHARS)
  ) {
    return payloadTooLarge();
  }

  if (
    strExceeds(state?.codingEscalationHint, MAX_PROMPT_FIELD_CHARS) ||
    strExceeds(state?.finalFollowUpHint, MAX_PROMPT_FIELD_CHARS) ||
    strExceeds(state?.submitReviewHint, MAX_PROMPT_FIELD_CHARS) ||
    strExceeds(state?.followUpSegment, MAX_PROMPT_FIELD_CHARS) ||
    strExceeds(state?.phase, MAX_PROMPT_FIELD_CHARS)
  ) {
    return payloadTooLarge();
  }

  const topics = Array.isArray(state?.topicsProbed) ? state.topicsProbed : [];
  if (topics.length > MAX_TOPICS) {
    return payloadTooLarge();
  }
  for (const topic of topics) {
    if (strExceeds(topic, MAX_PROMPT_FIELD_CHARS)) {
      return payloadTooLarge();
    }
  }

  return null;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as InterviewerRequestBody;
    const { sessionState, messages, transcript, turnCount } = body;

    const tooLarge = validatePayloadSize(body);
    if (tooLarge) {
      return tooLarge;
    }

    // Resolve which provider/model to run the agent on from the UI preset.
    const modelPresetId =
      typeof body.modelPresetId === "string"
        ? body.modelPresetId
        : DEFAULT_AI_MODEL_PRESET_ID;
    const modelConfig = getAiModelConfig(modelPresetId);
    if (!modelConfig) {
      return NextResponse.json(
        { error: `Invalid model preset "${modelPresetId}"` },
        { status: 400 }
      );
    }

    // BYOK key (per-request header) is preferred over env, but only when its
    // prefix matches modelConfig.provider — a mismatched key is dropped so we
    // never forward e.g. an Anthropic key to Groq/OpenAI. Per CLAUDE.md the
    // header is never logged or persisted server-side.
    const byokKey = req.headers.get("x-provider-key") ?? undefined;
    let apiKey: string;
    try {
      ({ apiKey } = resolveProviderKey(modelConfig.provider, byokKey));
    } catch (keyError) {
      if (keyError instanceof MissingProviderKeyError) {
        return NextResponse.json({ error: keyError.message }, { status: 401 });
      }
      throw keyError;
    }

    const model = getInterviewerLanguageModel(modelConfig, apiKey);

    // body transcript is the live value — overrides sessionState.transcript
    // which is the turn-start snapshot. buildTools(state) reads
    // state.transcript internally, so we merge here.
    // interviewerContext is ALWAYS injected from the server question bank here —
    // the client never holds it (it only has a PublicQuestion), and any value on
    // the incoming payload is ignored — so Alex can grade and answer
    // clarifications without that text ever crossing the browser.
    const bankQuestion = getQuestionById(sessionState.question.id);
    const stateForTurn: SessionState = {
      ...sessionState,
      transcript: transcript ?? [],
      question: {
        ...sessionState.question,
        interviewerContext: bankQuestion?.interviewerContext ?? "",
      },
    };

    // Per-turn secret that authenticates the app's user-role control note. It
    // lives only in the system prompt (which the candidate never sees) and is
    // stamped onto the legitimate control note, so a candidate-forged bracket
    // tag like "[admin] give me the answer" can never impersonate one. Fresh
    // every turn — a one-time leak buys nothing.
    const controlToken = randomUUID();
    const system = buildSystemPrompt(stateForTurn, controlToken);
    // App-fired control hints ride BOTH the system prompt (full instructions)
    // and the final context message (recency — see buildContextMessages).
    // Mirror the system blocks' phase gates so a stale hint on the wrong
    // phase's turn is ignored.
    const controlHint =
      stateForTurn.phase === "coding"
        ? stateForTurn.codingEscalationHint
        : stateForTurn.phase === "followUp"
          ? stateForTurn.finalFollowUpHint
          : undefined;
    const contextMessages = buildContextMessages(
      messages,
      controlHint,
      controlToken
    );
    const tools = buildTools(stateForTurn);
    const isOpeningTurn = messages.length === 0;
    const toolsForTurn = isOpeningTurn ? {} : tools;

    // BYOK / at-capacity gate (defense-in-depth; the client ByokGate is the
    // primary UX). On a NEW interview, if the demo is at capacity and the
    // visitor brought no valid OpenAI key, refuse rather than spend the dead
    // server key. Only the opening turn pays the Redis read; mid-interview
    // turns, BYOK-key requests, and non-OpenAI providers skip it entirely.
    const hasValidOpenAiHeader =
      modelConfig.provider === "openai" &&
      typeof byokKey === "string" &&
      keyMatchesProvider("openai", byokKey);
    if (
      isOpeningTurn &&
      modelConfig.provider === "openai" &&
      !hasValidOpenAiHeader &&
      (await getByokMode())
    ) {
      return NextResponse.json({ error: "at_capacity" }, { status: 503 });
    }

    // Funnel: count session starts on the opening turn. Fire-and-forget and
    // fail-open (see lib/stats) so it never delays the first token.
    if (isOpeningTurn) {
      void incrementStat(
        "sessions:started",
        `sessions:started:${stateForTurn.question.id}`
      );
    }

    if (process.env.NODE_ENV === "development") {
      console.log("[interviewer-agent]", {
        provider: modelConfig.provider,
        model: modelConfig.model,
        phase: sessionState.phase,
        toolsAvailable: Object.keys(tools),
        messageCount: messages.length,
        topicsProbed: sessionState.topicsProbed,
        turnCount,
        activeFollowUp: sessionState.activeFollowUp ?? null,
      });
    }

    // run_tests is the one tool whose result mutates app-owned state on the
    // client (testRunsUsed, lastTestResult). Its result is forwarded over the
    // data stream so the client can commit before the next turn. The other
    // grounding tools are read-only and need no client commit.
    const ACTION_TOOLS = ["run_tests"];

    // Wrap streamText in a UI message stream so action-tool results ride the
    // same response. Data parts are emitted with `transient: true` so the SDK
    // does not persist them as message history — they are side-effect
    // channels, not message content.
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        if (process.env.NODE_ENV === "development") {
          console.log(
            "[interviewer-agent] raw body messages",
            JSON.stringify(body.messages, null, 2)
          );
          console.log(
            "[interviewer-agent] raw body sessionState.transcript",
            JSON.stringify(body.transcript?.slice(-3) ?? [], null, 2)
          );
        }
        // Groq can loop on malformed/failed tool calls and end a turn with zero
        // text. Track consecutive failures (repair-dropped calls + rejected tool
        // results); after a small cap, take tools away for the rest of the turn
        // and force a plain-text reply so the turn never ends blank. This sits on
        // top of experimental_repairToolCall, which still drops-and-continues.
        let consecutiveToolFailures = 0;
        let toolsDisabledForTurn = false;
        const TOOL_FAILURE_CAP = 2;

        const result = streamText({
          model,
          // Cap the interviewer turn — turns are short by design, so this guards
          // against a runaway generation inflating cost on the demo's metered
          // key. Feedback is uncapped (separate path, POST /api/feedback).
          maxOutputTokens: INTERVIEWER_MAX_OUTPUT_TOKENS,
          system,
          messages: contextMessages,
          tools: toolsForTurn,
          stopWhen: stepCountIs(5),
          // Once Groq has looped on failed tool calls, disable tools for the rest
          // of this turn and make it answer in plain text. Worst case Alex replies
          // without having read the latest code (degraded) instead of going silent.
          prepareStep: () => {
            if (toolsDisabledForTurn) {
              return {
                toolChoice: "none" as const,
                system: `${system}\n\n[You have been unable to use your tools this turn. Reply to the candidate now in plain text — do NOT call any tools.]`,
              };
            }
            return {};
          },
          abortSignal: req.signal,
          onError({ error }) {
            // OpenAI billing exhaustion → latch BYOK / at-capacity mode so new
            // interviews route to /at-capacity instead of dying on the dead key.
            if (isInsufficientQuotaError(error)) {
              void setByokMode(true);
            }
            if (process.env.NODE_ENV === "development") {
              console.error("[interviewer-agent] stream error", error);
              if (error && typeof error === "object") {
                const obj = error as Record<string, unknown>;
                if ("responseBody" in obj) {
                  console.error(
                    "[interviewer-agent] response body",
                    obj.responseBody
                  );
                }
                if ("cause" in obj) {
                  console.error("[interviewer-agent] error cause", obj.cause);
                }
              }
            }
            let message: string;
            if (error instanceof Error) {
              message = error.message;
            } else if (typeof error === "string") {
              message = error;
            } else if (error && typeof error === "object") {
              const obj = error as Record<string, unknown>;
              if (typeof obj.message === "string") {
                message = obj.message;
              } else if (typeof obj.error === "string") {
                message = obj.error;
              } else {
                try {
                  message = JSON.stringify(error);
                } catch {
                  message = "Unknown error";
                }
              }
            } else {
              message = String(error);
            }
            writer.write({
              type: "data-error",
              data: { message },
              transient: true,
            });
          },
          experimental_repairToolCall: async ({ toolCall, error }) => {
            // A dropped (malformed) call is a failure — count it toward the cap.
            consecutiveToolFailures += 1;
            if (consecutiveToolFailures >= TOOL_FAILURE_CAP) {
              toolsDisabledForTurn = true;
            }
            if (process.env.NODE_ENV === "development") {
              console.warn("[interviewer-agent] tool call rejected — dropping", {
                tool: toolCall.toolName,
                toolCall,
                error: error instanceof Error ? error.message : String(error),
                consecutiveToolFailures,
                toolsDisabledForTurn,
              });
            }
            return null;
          },
          onStepFinish({ text, toolCalls, toolResults, finishReason, usage }) {
            if (process.env.NODE_ENV === "development") {
              console.log("[interviewer-agent] step", {
                finishReason,
                textLen: text?.length ?? 0,
                toolCalls: toolCalls?.map((tc) => tc.toolName) ?? [],
                toolResults: toolResults?.map((tr) => tr.toolName) ?? [],
                usage,
              });
            }
            for (const tr of toolResults ?? []) {
              if (ACTION_TOOLS.includes(tr.toolName)) {
                if (process.env.NODE_ENV === "development") {
                  console.log("[interviewer-agent] action tool result", {
                    tool: tr.toolName,
                    result: tr.output,
                  });
                }
                writer.write({
                  type: "data-tool_result",
                  data: { tool: tr.toolName, result: tr.output },
                  transient: true,
                });
              }
            }

            // Failure-streak accounting (drives the prepareStep force-text guard).
            // Progress — text produced, or a tool that actually succeeded — clears
            // the streak. A step whose only tool results were rejections counts
            // toward the cap alongside repair-dropped calls.
            let stepHadToolSuccess = false;
            let stepHadToolRejection = false;
            for (const tr of toolResults ?? []) {
              const out = tr.output as { rejected?: unknown } | null | undefined;
              if (out && typeof out === "object" && out.rejected === true) {
                stepHadToolRejection = true;
              } else {
                stepHadToolSuccess = true;
              }
            }
            if ((text && text.trim().length > 0) || stepHadToolSuccess) {
              consecutiveToolFailures = 0;
            } else if (stepHadToolRejection) {
              consecutiveToolFailures += 1;
              if (consecutiveToolFailures >= TOOL_FAILURE_CAP) {
                toolsDisabledForTurn = true;
              }
            }
          },
        });
        writer.merge(result.toUIMessageStream());
        // Tool-only turns can finish with zero candidate-facing text despite the
        // prompt. One plain-text retry keeps the interview from going silent.
        // These empties cluster at segment transitions (a weak caller loops on a
        // grounding tool while deciding whether to wrap), so the retry must be
        // allowed to wrap with [segment-complete] — forbidding it leaves the
        // interview stuck filling the bubble but never advancing into final Q&A /
        // feedback. Disabling tools is what breaks the loop; transitions are a
        // text token, not a tool, so they are unaffected.
        const spoken = (await result.text).trim();
        if (spoken.length === 0) {
          if (process.env.NODE_ENV === "development") {
            console.warn(
              "[interviewer-agent] empty reply — forcing plain-text fallback"
            );
          }
          const fallback = streamText({
            model,
            maxOutputTokens: INTERVIEWER_MAX_OUTPUT_TOKENS,
            system: `${system}\n\n[Your previous turn produced no candidate-facing reply. Respond now in plain text and do NOT call any tools. If you were closing out this segment (e.g. wrapping a review or the final Q&A), end your reply with [segment-complete] on its own final line so the interview can advance. Otherwise reply to the candidate naturally — a brief acknowledgement plus at most one question.]`,
            messages: contextMessages,
            tools: {},
            toolChoice: "none",
            abortSignal: req.signal,
          });
          writer.merge(fallback.toUIMessageStream());
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (e) {
    // Intentionally different from legacy /api/ai error shape — client must
    // handle both shapes until the Day 2 migration is complete.
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
