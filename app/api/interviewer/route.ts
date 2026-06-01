// The single interviewer brain (POST /api/interviewer). Handles every
// conversational turn — opening, clarifying, planning, coding guidance,
// escalations, follow-ups, nudges — from one system prompt plus live state.
// Built on Vercel AI SDK 6 streamText with grounding-only tool calling.
// Phase is app metadata (the model signals readiness with inline tokens; the
// client commits). The written scorecard is a separate grounded generation
// (POST /api/feedback). Default provider is Groq; any preset works via BYOK.

import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
} from "ai";
import { NextResponse, type NextRequest } from "next/server";

import {
  DEFAULT_AI_MODEL_PRESET_ID,
  getAiModelConfig,
} from "@/lib/ai-models";
import type { ChatMessage, TranscriptEntry } from "@/lib/chat";
import { getInterviewerLanguageModel } from "@/lib/interviewer-model";
import {
  buildContextMessages,
  buildSystemPrompt,
} from "@/lib/interviewer-prompt";
import { buildTools } from "@/lib/interviewer-tools";
import { getQuestionById } from "@/lib/questions";
import {
  MissingProviderKeyError,
  resolveProviderKey,
} from "@/lib/resolve-provider-key";
import type { SessionState } from "@/lib/session-state";
import { summarizeSession } from "@/lib/summarize";

export const runtime = "nodejs";

type InterviewerRequestBody = {
  sessionState: SessionState;
  messages: ChatMessage[];
  rollingSummary: string;
  transcript: TranscriptEntry[];
  turnCount: number;
  modelPresetId?: string;
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as InterviewerRequestBody;
    const { sessionState, messages, rollingSummary, transcript, turnCount } =
      body;

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

    // Summaries still run on the utility provider (Groq fallback) unless
    // ANTHROPIC_API_KEY env is set (summarizeSession's primary path). Resolve a
    // Groq-matched key for that fallback only — the interviewer BYOK key is
    // forwarded to summarize only when it is itself a Groq key. When the
    // interviewer runs on a non-Groq provider with no GROQ_API_KEY env and no
    // Anthropic env, summaries are skipped (failure is swallowed downstream).
    const summarizeGroqKey =
      (byokKey?.startsWith("gsk_") ? byokKey : undefined) ??
      process.env.GROQ_API_KEY;

    // This turn's context uses the OLD rollingSummary. When a refresh is due,
    // the new summary is emitted on the data-stream channel (see execute
    // below) — NOT a response header — so summary latency does not affect
    // TTFB. messages.slice(-5) compresses only what's new since last summarize.
    const summarizeFired = turnCount > 0 && turnCount % 5 === 0;

    // body transcript is the live value — overrides sessionState.transcript
    // which is the turn-start snapshot. buildTools(state) reads
    // state.transcript internally, so we merge here.
    // interviewerContext is always taken from the server question bank (never
    // trust the client payload) so Alex can answer clarifications without
    // exposing hidden tests in tool returns.
    const bankQuestion = getQuestionById(sessionState.question.id);
    const stateForTurn: SessionState = {
      ...sessionState,
      transcript: transcript ?? [],
      question: {
        ...sessionState.question,
        interviewerContext:
          bankQuestion?.interviewerContext ??
          sessionState.question.interviewerContext ??
          "",
      },
    };

    const system = buildSystemPrompt(stateForTurn);
    const contextMessages = buildContextMessages(rollingSummary, messages);
    const tools = buildTools(stateForTurn);
    const isOpeningTurn = messages.length === 0;
    const toolsForTurn = isOpeningTurn ? {} : tools;

    if (process.env.NODE_ENV === "development") {
      console.log("[interviewer-agent]", {
        provider: modelConfig.provider,
        model: modelConfig.model,
        phase: sessionState.phase,
        toolsAvailable: Object.keys(tools),
        messageCount: messages.length,
        topicsProbed: sessionState.topicsProbed,
        turnCount,
        summarizeFired,
      });
    }

    // run_tests is the one tool whose result mutates app-owned state on the
    // client (testRunsUsed, lastTestResult). Its result is forwarded over the
    // data stream so the client can commit before the next turn. The other
    // grounding tools are read-only and need no client commit.
    const ACTION_TOOLS = ["run_tests"];

    // Wrap streamText in a UI message stream so the new rolling summary and
    // action-tool results ride the same response. Model output and summary
    // call run in parallel; the response closes once both writers finish.
    // TTFB is unaffected by summary latency. Data parts are emitted with
    // `transient: true` so the SDK does not persist them as message history —
    // they are side-effect channels, not message content.
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
        const result = streamText({
          model,
          system,
          messages: contextMessages,
          tools: toolsForTurn,
          stopWhen: stepCountIs(5),
          // summarizeSession below does not receive this signal — it will run
          // to its 30s timeout on disconnect. Fix requires adding
          // signal?: AbortSignal to summarize.ts — tracked for post-Day-2.
          abortSignal: req.signal,
          onError({ error }) {
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
            if (process.env.NODE_ENV === "development") {
              console.warn("[interviewer-agent] tool call rejected — dropping", {
                tool: toolCall.toolName,
                toolCall,
                error: error instanceof Error ? error.message : String(error),
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
          },
        });
        writer.merge(result.toUIMessageStream());

        if (summarizeFired) {
          try {
            const newSummary = await summarizeSession(
              rollingSummary,
              messages.slice(-5),
              summarizeGroqKey
            );
            if (newSummary !== rollingSummary) {
              writer.write({
                type: "data-summary",
                data: { value: newSummary },
                transient: true,
              });
            }
          } catch {
            // Silent fallback — summary failure must never break the turn.
          }
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
