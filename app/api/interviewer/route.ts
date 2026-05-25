// New agent route (POST /api/interviewer). Replaces the `message` kind from
// the legacy /api/ai route. Uses Vercel AI SDK 6 streamText with tool calling
// against Groq's OpenAI-compatible endpoint. Do not delete /api/ai — it still
// handles `opening` and `feedback` until the Day 2 migration.

import { createOpenAI } from "@ai-sdk/openai";
import { createDataStreamResponse, streamText } from "ai";
import { NextResponse, type NextRequest } from "next/server";

import type { ChatMessage, TranscriptEntry } from "@/lib/chat";
import {
  buildContextMessages,
  buildSystemPrompt,
} from "@/lib/interviewer-prompt";
import { buildTools } from "@/lib/interviewer-tools";
import type { SessionState } from "@/lib/session-state";
import { summarizeSession } from "@/lib/summarize";

export const runtime = "nodejs";

type InterviewerRequestBody = {
  sessionState: SessionState;
  messages: ChatMessage[];
  rollingSummary: string;
  transcript: TranscriptEntry[];
  turnCount: number;
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as InterviewerRequestBody;
    const { sessionState, messages, rollingSummary, transcript, turnCount } =
      body;

    // Only Groq BYOK keys accepted on this route — non-Groq keys are silently
    // ignored to prevent credential leak to wrong provider. Per CLAUDE.md the
    // header itself is never logged or persisted server-side.
    const byokKey = req.headers.get("x-provider-key") ?? undefined;
    const groqKey =
      (byokKey?.startsWith("gsk_") ? byokKey : undefined) ??
      process.env.GROQ_API_KEY;

    if (
      process.env.NODE_ENV === "development" &&
      byokKey &&
      !byokKey.startsWith("gsk_")
    ) {
      console.log(
        "[interviewer-agent] BYOK key ignored — not a Groq key"
      );
    }

    if (!groqKey) {
      return NextResponse.json(
        { error: "No Groq API key configured" },
        { status: 401 }
      );
    }

    // Groq exposes an OpenAI-compatible API. Constructed per-request so BYOK
    // can override the server env key.
    const groq = createOpenAI({
      baseURL: "https://api.groq.com/openai/v1",
      apiKey: groqKey,
    });

    // This turn's context uses the OLD rollingSummary. When a refresh is due,
    // the new summary is emitted on the data-stream channel (see execute
    // below) — NOT a response header — so summary latency does not affect
    // TTFB. messages.slice(-5) compresses only what's new since last summarize.
    const summarizeFired = turnCount > 0 && turnCount % 5 === 0;

    // body transcript is the live value — overrides sessionState.transcript
    // which is the turn-start snapshot. buildTools(state) reads
    // state.transcript internally, so we merge here.
    const stateForTurn: SessionState = {
      ...sessionState,
      transcript,
    };

    const system = buildSystemPrompt(stateForTurn);
    const contextMessages = buildContextMessages(rollingSummary, messages);
    const tools = buildTools(stateForTurn);

    if (process.env.NODE_ENV === "development") {
      console.log("[interviewer-agent]", {
        phase: sessionState.phase,
        toolsAvailable: Object.keys(tools),
        messageCount: messages.length,
        topicsProbed: sessionState.topicsProbed,
        turnCount,
        summarizeFired,
      });
    }

    // Wrap streamText in a data-stream response so the new rolling summary
    // can ride the same stream as a typed data event. Model output and
    // summary call run in parallel; the response closes once both writers
    // finish. TTFB is unaffected by summary latency.
    return createDataStreamResponse({
      execute: async (dataStream) => {
        const result = streamText({
          model: groq("llama-3.3-70b-versatile"),
          system,
          messages: contextMessages,
          tools,
          maxSteps: 8,
          abortSignal: req.signal,
        });
        try {
          result.mergeIntoDataStream(dataStream);
        } catch (err) {
          dataStream.writeData({
            error: err instanceof Error ? err.message : "Stream error",
          });
        }

        if (summarizeFired) {
          try {
            const newSummary = await summarizeSession(
              rollingSummary,
              messages.slice(-5),
              groqKey
            );
            if (newSummary !== rollingSummary) {
              dataStream.writeData({ updatedSummary: newSummary });
            }
          } catch {
            // Silent fallback — summary failure must never break the turn.
          }
        }
      },
    });
  } catch (e) {
    // Intentionally different from legacy /api/ai error shape — client must
    // handle both shapes until the Day 2 migration is complete.
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
