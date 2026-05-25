import {
  generateRollingSummary,
  getFeedback,
  sendMessage,
  streamCodingEscalationNudge,
  streamFollowUpClosing,
  streamFollowUpOpener,
  streamSliceFollowUpOpener,
  streamForcedWrapOpener,
  streamOpeningMessage,
  streamPlanningPhaseOpener,
  type FeedbackSnapshot,
  type FollowUpTurnContext,
  type InterviewLevel,
  type PaceReport,
} from "@/lib/ai";
import type { ChatMessage, SessionPhase } from "@/lib/chat";
import { toClientAiFailure } from "@/lib/ai-errors";
import {
  type AiModelConfig,
  getAiModelConfig,
} from "@/lib/ai-models";
import { isConcreteInterviewerStyle } from "@/lib/interviewer-presets";
import type { CodingVoiceReport } from "@/lib/coding-voice-report";

function isInterviewLevel(v: unknown): v is InterviewLevel {
  return (
    v === "intern" || v === "new-grad" || v === "mid" || v === "senior"
  );
}

export const runtime = "nodejs";

type OpeningBody = {
  kind: "opening";
  modelPresetId: string;
  candidateDescription: string;
  interviewerContext: string;
};

type PlanningBody = {
  kind: "planningOpener";
  modelPresetId: string;
  candidateDescription: string;
  interviewerContext: string;
};

type SliceFollowUpOpenerBody = {
  kind: "sliceFollowUpOpener";
  modelPresetId: string;
  candidateDescription: string;
  interviewerContext: string;
  finalCode: string;
  testsSummary: string;
  questionDifficulty?: string;
  priorChatHistory?: ChatMessage[];
  rollingContext?: string;
};

type FollowUpOpenerBody = {
  kind: "followUpOpener";
  modelPresetId: string;
  candidateDescription: string;
  interviewerContext: string;
  finalCode: string;
  testsSummary: string;
  questionDifficulty?: string;
  preAuthoredFollowUpTotal?: number;
  priorChatHistory?: ChatMessage[];
  rollingContext?: string;
};

type FollowUpCloseBody = {
  kind: "followUpClose";
  modelPresetId: string;
};

type ForcedWrapOpenerBody = {
  kind: "forcedWrapOpener";
  modelPresetId: string;
  finalCode: string;
};

type CodingEscalationNudgeBody = {
  kind: "codingEscalationNudge";
  modelPresetId: string;
  priorChatHistory: ChatMessage[];
  currentCode: string;
  hint: string;
  codingEscalationStep: number;
  rollingContext?: string;
};

type MessageBody = {
  kind: "message";
  modelPresetId: string;
  messages: ChatMessage[];
  currentCode: string;
  phase: SessionPhase;
  followUpTurnContext?: FollowUpTurnContext;
  rollingContext?: string;
  remainingMs?: number;
  hiddenTestNudge?: string;
  interviewerStyle?: string;
  phaseElapsedMs?: number;
  questionDifficulty?: string;
  codingEscalationStep?: number;
  forcedWrapHint?: boolean;
  ambientTail?: string;
};

type SummarizeBody = {
  kind: "summarize";
  modelPresetId: string;
  messages: ChatMessage[];
};

type FeedbackBody = {
  kind: "feedback";
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

type AiRequestBody =
  | OpeningBody
  | PlanningBody
  | SliceFollowUpOpenerBody
  | FollowUpOpenerBody
  | FollowUpCloseBody
  | ForcedWrapOpenerBody
  | CodingEscalationNudgeBody
  | MessageBody
  | SummarizeBody
  | FeedbackBody;

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function parseFollowUpTurnContext(
  phase: SessionPhase,
  raw: unknown
): FollowUpTurnContext | null {
  if (phase !== "followUp") {
    return null;
  }
  if (raw === null || typeof raw !== "object") {
    throw new Error("followUpTurnContext is required in follow-up phase");
  }
  const o = raw as Record<string, unknown>;
  const c = o.completedAssistantTurns;
  const le = o.ladderExhausted;
  const p = o.preAuthoredFollowUpTotal;
  const d = o.difficulty;
  if (typeof c !== "number" || !Number.isInteger(c) || c < 0) {
    throw new Error("Invalid followUpTurnContext.completedAssistantTurns");
  }
  if (typeof le !== "boolean") {
    throw new Error("Invalid followUpTurnContext.ladderExhausted");
  }
  const preAuthoredFollowUpTotal =
    typeof p === "number" && Number.isInteger(p) && p >= 0
      ? p
      : 0;
  const difficulty = typeof d === "string" && d.length > 0 ? d : "medium";
  const seg = o.segment;
  const segment: "slice" | "final" =
    seg === "slice" || seg === "final" ? seg : "final";
  const sw = o.sliceWrapUp;
  const sliceWrapUp = sw === true ? true : undefined;
  return {
    completedAssistantTurns: c,
    ladderExhausted: le,
    preAuthoredFollowUpTotal,
    difficulty,
    segment,
    ...(sliceWrapUp ? { sliceWrapUp } : {}),
  };
}

function parseCodingVoiceReport(raw: unknown): CodingVoiceReport | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== "object") {
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
  let body: AiRequestBody;
  try {
    body = (await req.json()) as AiRequestBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const resolved = getAiModelConfig(body.modelPresetId);
  if (resolved == null) {
    return jsonError("Invalid modelPresetId", 400);
  }
  const aiModelConfig: AiModelConfig = resolved;

  // BYOK: if the client sent a key via x-provider-key, use it instead of the env var.
  // The header is never logged or persisted.
  const requestApiKey = req.headers.get("x-provider-key") ?? undefined;

  const encoder = new TextEncoder();

  async function* streamForKind(): AsyncGenerator<string> {
    switch (body.kind) {
      case "opening":
        yield* streamOpeningMessage(
          aiModelConfig,
          body.candidateDescription,
          body.interviewerContext,
          requestApiKey
        );
        break;
      case "planningOpener":
        yield* streamPlanningPhaseOpener(
          aiModelConfig,
          body.candidateDescription,
          body.interviewerContext,
          requestApiKey
        );
        break;
      case "sliceFollowUpOpener":
        yield* streamSliceFollowUpOpener(
          aiModelConfig,
          body.candidateDescription,
          body.interviewerContext,
          body.finalCode,
          body.testsSummary,
          typeof body.questionDifficulty === "string" &&
            body.questionDifficulty.length > 0
            ? body.questionDifficulty
            : "medium",
          Array.isArray(body.priorChatHistory) ? body.priorChatHistory : [],
          typeof body.rollingContext === "string" ? body.rollingContext : null,
          requestApiKey
        );
        break;
      case "followUpOpener":
        yield* streamFollowUpOpener(
          aiModelConfig,
          body.candidateDescription,
          body.interviewerContext,
          body.finalCode,
          body.testsSummary,
          typeof body.questionDifficulty === "string" &&
            body.questionDifficulty.length > 0
            ? body.questionDifficulty
            : "medium",
          typeof body.preAuthoredFollowUpTotal === "number" &&
            Number.isInteger(body.preAuthoredFollowUpTotal) &&
            body.preAuthoredFollowUpTotal >= 0
            ? body.preAuthoredFollowUpTotal
            : 0,
          Array.isArray(body.priorChatHistory) ? body.priorChatHistory : [],
          typeof body.rollingContext === "string" ? body.rollingContext : null,
          requestApiKey
        );
        break;
      case "followUpClose":
        yield* streamFollowUpClosing(aiModelConfig, requestApiKey);
        break;
      case "forcedWrapOpener":
        yield* streamForcedWrapOpener(
          aiModelConfig,
          body.finalCode,
          requestApiKey
        );
        break;
      case "codingEscalationNudge":
        yield* streamCodingEscalationNudge(
          aiModelConfig,
          Array.isArray(body.priorChatHistory) ? body.priorChatHistory : [],
          typeof body.currentCode === "string" ? body.currentCode : "",
          typeof body.hint === "string" ? body.hint : "",
          typeof body.codingEscalationStep === "number" &&
            Number.isInteger(body.codingEscalationStep) &&
            body.codingEscalationStep >= 0
            ? body.codingEscalationStep
            : 0,
          typeof body.rollingContext === "string" ? body.rollingContext : null,
          requestApiKey
        );
        break;
      case "message": {
        const followUpCtx = parseFollowUpTurnContext(
          body.phase,
          body.followUpTurnContext
        );
        yield* sendMessage(
          aiModelConfig,
          body.messages,
          body.currentCode,
          body.phase,
          followUpCtx,
          typeof body.rollingContext === "string" ? body.rollingContext : null,
          typeof body.remainingMs === "number" ? body.remainingMs : null,
          typeof body.hiddenTestNudge === "string" ? body.hiddenTestNudge : null,
          isConcreteInterviewerStyle(body.interviewerStyle)
            ? body.interviewerStyle
            : null,
          typeof body.phaseElapsedMs === "number" ? body.phaseElapsedMs : null,
          typeof body.questionDifficulty === "string" && body.questionDifficulty.length > 0
            ? body.questionDifficulty
            : null,
          typeof body.codingEscalationStep === "number" &&
            Number.isInteger(body.codingEscalationStep) &&
            body.codingEscalationStep >= 0
            ? body.codingEscalationStep
            : null,
          body.forcedWrapHint === true,
          typeof body.ambientTail === "string" && body.ambientTail.length > 0
            ? body.ambientTail
            : null,
          requestApiKey
        );
        break;
      }
      case "summarize":
        yield* generateRollingSummary(aiModelConfig, body.messages, requestApiKey);
        break;
      case "feedback":
        yield* getFeedback(
          aiModelConfig,
          body.question,
          body.fullTranscript,
          body.snapshots,
          body.finalCode,
          body.chatHistory,
          typeof body.traceContent === "string" ? body.traceContent : null,
          isConcreteInterviewerStyle(body.interviewerStyle)
            ? body.interviewerStyle
            : null,
          body.paceReport != null ? body.paceReport : null,
          isInterviewLevel(body.level) ? body.level : null,
          parseCodingVoiceReport(body.codingVoiceReport),
          requestApiKey
        );
        break;
      default:
        throw new Error("Unknown request kind");
    }
  }

  const gen = streamForKind();
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
