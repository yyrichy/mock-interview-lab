// POST /api/feedback — the single end-of-session scorecard path. Plain-text
// streaming (AsyncGenerator) of a grounded generation over the full evidence.
// Triggered by the app (Continue button / round-clock backstop), never by a
// model tool call. This is the only remaining non-conversational AI route; all
// turn-by-turn conversation goes through POST /api/interviewer.

import { toClientAiFailure } from "@/lib/ai-errors";
import { type AiModelConfig, getAiModelConfig } from "@/lib/ai-models";
import type { ChatMessage } from "@/lib/chat";
import type { CodingVoiceReport } from "@/lib/coding-voice-report";
import {
  type FeedbackSnapshot,
  type InterviewLevel,
  type PaceReport,
  streamFeedback,
} from "@/lib/feedback";
import { isConcreteInterviewerStyle } from "@/lib/interviewer-presets";

export const runtime = "nodejs";

type FeedbackBody = {
  modelPresetId: string;
  question: string;
  fullTranscript: string;
  snapshots: FeedbackSnapshot[];
  finalCode: string;
  chatHistory: ChatMessage[];
  traceContent?: string;
  interviewerStyle?: string;
  paceReport?: PaceReport;
  level?: string;
  codingVoiceReport?: CodingVoiceReport;
};

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function isInterviewLevel(v: unknown): v is InterviewLevel {
  return v === "intern" || v === "new-grad" || v === "mid" || v === "senior";
}

function parseCodingVoiceReport(raw: unknown): CodingVoiceReport | null {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const uc = o.utteranceCount;
  const wc = o.wordCount;
  const n = o.negligibleThinkAloud;
  if (
    typeof uc !== "number" ||
    !Number.isInteger(uc) ||
    uc < 0 ||
    typeof wc !== "number" ||
    !Number.isInteger(wc) ||
    wc < 0 ||
    typeof n !== "boolean"
  ) {
    return null;
  }
  return {
    utteranceCount: uc,
    wordCount: wc,
    negligibleThinkAloud: n,
  };
}

export async function POST(req: Request) {
  let body: FeedbackBody;
  try {
    body = (await req.json()) as FeedbackBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const resolved = getAiModelConfig(body.modelPresetId);
  if (resolved == null) {
    return jsonError("Invalid modelPresetId", 400);
  }
  const aiModelConfig: AiModelConfig = resolved;

  // BYOK: if the client sent a key via x-provider-key, use it instead of the env
  // var. The header is never logged or persisted.
  const requestApiKey = req.headers.get("x-provider-key") ?? undefined;

  const encoder = new TextEncoder();

  const gen = streamFeedback(
    aiModelConfig,
    body.question,
    body.fullTranscript,
    Array.isArray(body.snapshots) ? body.snapshots : [],
    body.finalCode,
    Array.isArray(body.chatHistory) ? body.chatHistory : [],
    typeof body.traceContent === "string" ? body.traceContent : null,
    isConcreteInterviewerStyle(body.interviewerStyle)
      ? body.interviewerStyle
      : null,
    body.paceReport != null ? body.paceReport : null,
    isInterviewLevel(body.level) ? body.level : null,
    parseCodingVoiceReport(body.codingVoiceReport),
    requestApiKey
  );

  let first: IteratorResult<string>;
  try {
    first = await gen.next();
  } catch (e: unknown) {
    const { message, status } = toClientAiFailure(e, {
      provider: aiModelConfig.provider,
    });
    return jsonError(message, status);
  }

  if (first.done) {
    return jsonError("The model returned no output.", 502);
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(first.value));
        for await (const chunk of gen) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch (e: unknown) {
        const { message } = toClientAiFailure(e, {
          provider: aiModelConfig.provider,
        });
        controller.enqueue(encoder.encode(`\n\n[Error: ${message}]`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
