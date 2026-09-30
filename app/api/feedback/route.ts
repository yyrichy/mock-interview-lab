// POST /api/feedback — the single end-of-session scorecard path. Plain-text
// streaming (AsyncGenerator) of a grounded generation over the full evidence.
// Triggered by the app (Continue button / round-clock backstop), never by a
// model tool call. This is the only remaining non-conversational AI route; all
// turn-by-turn conversation goes through POST /api/interviewer.

import { randomUUID } from "node:crypto";

import { isInsufficientQuotaError, toClientAiFailure } from "@/lib/ai-errors";
import {
  GEMINI_RECOVERY_MODEL,
  type AiModelConfig,
  getAiModelConfig,
} from "@/lib/ai-models";
import { setByokMode } from "@/lib/byok-mode";
import type { ChatMessage } from "@/lib/chat";
import type { CodingVoiceReport } from "@/lib/coding-voice-report";
import {
  type FeedbackFollowUpVariant,
  type FeedbackSnapshot,
  type InterviewLevel,
  type PaceReport,
  streamFeedback,
} from "@/lib/feedback";
import { isConcreteInterviewerStyle } from "@/lib/interviewer-presets";
import {
  appendLocalDebugEvent,
  redactDebugMessage,
} from "@/lib/local-debug-archive";
import { incrementStat } from "@/lib/stats";
import type { ProviderFallbackInfo } from "@/lib/openrouter-fallback";

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
  followUpVariants?: FeedbackFollowUpVariant[];
};

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

// Hard caps on attacker-controllable payload fields, enforced before the model
// call so an oversized body can't run up cost or memory. EVERY client string
// that reaches the feedback prompt is bounded here — not just the obvious
// code/transcript blobs but the problem statement, dry-run trace, snapshot
// transcript notes, and follow-up variant prompts.
const MAX_CHAT_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 8000;
const MAX_CODE_CHARS = 15000;
const MAX_TRANSCRIPT_CHARS = 50000;
const MAX_SNAPSHOTS = 20;
const MAX_SNAPSHOT_CHARS = 5000;
const MAX_QUESTION_CHARS = 20000;
const MAX_TRACE_CHARS = 20000;
const MAX_PROMPT_FIELD_CHARS = 8000;
const MAX_FOLLOWUP_VARIANTS = 20;

/** True when `value` is a string longer than `max`. Non-strings never exceed. */
function strExceeds(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length > max;
}

/** Returns a 400 response if the request body exceeds size limits, else null. */
function validatePayloadSize(body: FeedbackBody): Response | null {
  const tooLarge = () => jsonError("payload_too_large", 400);

  const chatHistory = Array.isArray(body.chatHistory) ? body.chatHistory : [];
  if (chatHistory.length > MAX_CHAT_MESSAGES) {
    return tooLarge();
  }
  for (const m of chatHistory) {
    if (strExceeds(m?.content, MAX_MESSAGE_CHARS)) {
      return tooLarge();
    }
  }

  if (
    strExceeds(body.fullTranscript, MAX_TRANSCRIPT_CHARS) ||
    strExceeds(body.finalCode, MAX_CODE_CHARS) ||
    strExceeds(body.question, MAX_QUESTION_CHARS) ||
    strExceeds(body.traceContent, MAX_TRACE_CHARS)
  ) {
    return tooLarge();
  }

  const snapshots = Array.isArray(body.snapshots) ? body.snapshots : [];
  if (snapshots.length > MAX_SNAPSHOTS) {
    return tooLarge();
  }
  for (const snap of snapshots) {
    if (
      strExceeds(snap?.code, MAX_SNAPSHOT_CHARS) ||
      strExceeds(snap?.transcript, MAX_SNAPSHOT_CHARS)
    ) {
      return tooLarge();
    }
  }

  const variants = Array.isArray(body.followUpVariants)
    ? body.followUpVariants
    : [];
  if (variants.length > MAX_FOLLOWUP_VARIANTS) {
    return tooLarge();
  }
  for (const v of variants) {
    if (
      strExceeds(v?.prompt, MAX_PROMPT_FIELD_CHARS) ||
      strExceeds(v?.entryFunction, MAX_PROMPT_FIELD_CHARS)
    ) {
      return tooLarge();
    }
  }

  return null;
}

function isInterviewLevel(v: unknown): v is InterviewLevel {
  return v === "intern" || v === "new-grad" || v === "mid" || v === "senior";
}

function parseFollowUpVariants(
  raw: unknown
): FeedbackFollowUpVariant[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const variants: FeedbackFollowUpVariant[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const o = item as Record<string, unknown>;
    if (typeof o.prompt !== "string" || o.prompt.trim().length === 0) {
      continue;
    }
    variants.push({
      prompt: o.prompt,
      ...(typeof o.entryFunction === "string" && o.entryFunction.trim().length > 0
        ? { entryFunction: o.entryFunction }
        : {}),
    });
  }
  return variants.length > 0 ? variants : null;
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
  const debugRequestId = randomUUID();
  const requestStartedAt = Date.now();
  let body: FeedbackBody;
  try {
    body = (await req.json()) as FeedbackBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const tooLarge = validatePayloadSize(body);
  if (tooLarge) {
    return tooLarge;
  }

  const resolved = getAiModelConfig(body.modelPresetId);
  if (resolved == null) {
    return jsonError("Invalid modelPresetId", 400);
  }
  const aiModelConfig: AiModelConfig = resolved;

  void appendLocalDebugEvent({
    type: "feedback.request",
    requestId: debugRequestId,
    provider: aiModelConfig.provider,
    model: aiModelConfig.model,
    chatMessageCount: Array.isArray(body.chatHistory)
      ? body.chatHistory.length
      : 0,
    transcriptLength:
      typeof body.fullTranscript === "string" ? body.fullTranscript.length : 0,
    snapshotCount: Array.isArray(body.snapshots) ? body.snapshots.length : 0,
    codeLength: typeof body.finalCode === "string" ? body.finalCode.length : 0,
  });

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
    parseFollowUpVariants(body.followUpVariants),
    requestApiKey,
    (info: ProviderFallbackInfo) => {
      void appendLocalDebugEvent({
        type: "feedback.provider_fallback",
        requestId: debugRequestId,
        fromProvider: "openrouter",
        fromModel: "cohere/north-mini-code:free",
        toProvider: "gemini",
        toModel: GEMINI_RECOVERY_MODEL.model,
        reason: info.reason,
        statusCode: info.statusCode,
      });
    }
  );

  let first: IteratorResult<string>;
  try {
    first = await gen.next();
  } catch (e: unknown) {
    if (isInsufficientQuotaError(e)) {
      void setByokMode(true);
    }
    const { message, status } = toClientAiFailure(e, {
      provider: aiModelConfig.provider,
    });
    void appendLocalDebugEvent({
      type: "feedback.error",
      requestId: debugRequestId,
      durationMs: Date.now() - requestStartedAt,
      status,
    });
    return jsonError(message, status);
  }

  if (first.done) {
    void appendLocalDebugEvent({
      type: "feedback.empty_reply",
      requestId: debugRequestId,
      durationMs: Date.now() - requestStartedAt,
    });
    return jsonError("The model returned no output.", 502);
  }

  // Funnel: a session reaches feedback exactly once. Fire-and-forget, fail-open.
  void incrementStat("sessions:finished");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(first.value));
        for await (const chunk of gen) {
          controller.enqueue(encoder.encode(chunk));
        }
        void appendLocalDebugEvent({
          type: "feedback.completed",
          requestId: debugRequestId,
          durationMs: Date.now() - requestStartedAt,
        });
        controller.close();
      } catch (e: unknown) {
        if (isInsufficientQuotaError(e)) {
          void setByokMode(true);
        }
        const { message } = toClientAiFailure(e, {
          provider: aiModelConfig.provider,
        });
        void appendLocalDebugEvent({
          type: "feedback.stream_error",
          requestId: debugRequestId,
          durationMs: Date.now() - requestStartedAt,
          message: redactDebugMessage(message),
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
