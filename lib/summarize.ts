// Rolling-summary compressor for the agent route. Caller (the new
// /api/interviewer route) decides cadence — typically every 5 turns — and this
// function does a single one-shot compression call.
//
// Primary path: Anthropic SDK directly with claude-haiku-4-5-20251001 (per
// CLAUDE.md, do not upgrade this model). Fallback: existing utility model
// preset via the same provider switch pattern used in lib/ai.ts.

import Anthropic from "@anthropic-ai/sdk";

import type { ChatMessage } from "./chat";
import {
  DEFAULT_UTILITY_MODEL_PRESET_ID,
  getAiModelConfig,
  type AiModelConfig,
} from "./ai-models";
import * as anthropicProvider from "./providers/anthropic";
import * as geminiProvider from "./providers/gemini";
import * as groqProvider from "./providers/groq";
import * as openaiProvider from "./providers/openai";

const SUMMARIZE_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 500;

// Sub-30-char outputs are almost certainly junk (truncation, refusal, empty).
// Never clobber a working summary with garbage — return previousSummary instead.
const MIN_USABLE_LENGTH = 30;

// Upper bound on summary length to keep context budget predictable across turns.
const MAX_SUMMARY_CHARS = 1500;

// Hard timeout on the model call. A network hang must not stall an agent turn.
const REQUEST_TIMEOUT_MS = 30_000;

const SUMMARIZER_SYSTEM =
  "You compress live coding-interview transcripts into concise factual summaries. Output facts only, no commentary or pleasantries.";

// No explicit word-count anchor on the previousSummary merge — summaries can
// grow slowly across turns. MAX_SUMMARY_CHARS caps the worst case; monitor if
// context budget tightens and add a stricter anchor here.
function buildPrompt(
  previousSummary: string,
  recentMessages: ChatMessage[]
): string {
  const formatted = recentMessages
    .map((m) =>
      m.role === "user"
        ? `Candidate: ${m.content}`
        : `Interviewer: ${m.content}`
    )
    .join("\n\n");

  return `You are summarizing a coding interview session for memory compression.

Previous summary:
${previousSummary || "(none yet)"}

Recent conversation to add:
${formatted}

Write a concise summary (max 300 words) capturing facts only:
- What approach the candidate described
- Complexity they stated
- What edge cases were discussed and resolved
- What topics were probed verbally
- Current state of the code at a high level
- Any open issues not yet addressed

Do not include what the interviewer said verbatim. Compress into facts only.`;
}

async function summarizeViaAnthropicSdk(prompt: string): Promise<string> {
  // Primary path uses server ANTHROPIC_API_KEY only — see BYOK LIMITATION
  // comment in summarizeSession.
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create(
    {
      model: SUMMARIZE_MODEL,
      max_tokens: MAX_TOKENS,
      system: SUMMARIZER_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  // Find the first text block — robust against tool_use/thinking blocks
  // appearing before the text payload.
  const block = response.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : "";
}

// Same switch pattern as lib/ai.ts:streamFromProvider, replicated locally so
// this module doesn't depend on legacy ai.ts internals.
async function* streamFromProvider(
  modelConfig: AiModelConfig,
  prompt: string,
  apiKey?: string
): AsyncGenerator<string> {
  const opts = {
    system: SUMMARIZER_SYSTEM,
    messages: [{ role: "user" as const, content: prompt }],
    model: modelConfig.model,
    apiKey,
  };
  switch (modelConfig.provider) {
    case "groq":
      yield* groqProvider.streamChat(opts);
      break;
    case "gemini":
      yield* geminiProvider.streamChat(opts);
      break;
    case "anthropic":
      yield* anthropicProvider.streamChat(opts);
      break;
    case "openai":
      yield* openaiProvider.streamChat(opts);
      break;
    default: {
      const _exhaustive: never = modelConfig.provider;
      throw new Error(`Unknown provider: ${String(_exhaustive)}`);
    }
  }
}

async function summarizeViaFallback(
  prompt: string,
  apiKey?: string
): Promise<string> {
  const cfg = getAiModelConfig(DEFAULT_UTILITY_MODEL_PRESET_ID);
  if (!cfg) {
    throw new Error(
      `Could not resolve fallback utility model preset "${DEFAULT_UTILITY_MODEL_PRESET_ID}"`
    );
  }
  // Fallback uses provider default for max_tokens — no cap enforced here.
  // Acceptable tradeoff: MIN_USABLE_LENGTH and MAX_SUMMARY_CHARS still bound output.
  let result = "";
  for await (const chunk of streamFromProvider(cfg, prompt, apiKey)) {
    result += chunk;
  }
  return result;
}

/**
 * Compress the conversation so far into a short factual summary suitable as a
 * single context message on subsequent turns. Caller decides cadence
 * (typically every 5 turns).
 *
 * Returns previousSummary unchanged on any failure or sub-30-char response —
 * never clobbers a working summary with garbage.
 */
export async function summarizeSession(
  previousSummary: string,
  recentMessages: ChatMessage[],
  byokApiKey?: string
): Promise<string> {
  // BYOK routing (asymmetric):
  // - ANTHROPIC_API_KEY env → Anthropic primary path (env only; byokApiKey is
  //   NOT forwarded here because we can't verify it is for Anthropic).
  // - No ANTHROPIC_API_KEY env → fallback to utility provider. byokApiKey IS
  //   forwarded here. The CALLER must guarantee the BYOK key matches the
  //   fallback provider (currently Groq via DEFAULT_UTILITY_MODEL_PRESET_ID);
  //   see app/api/interviewer/route.ts for the Groq-prefix gate.
  if (recentMessages.length === 0) {
    return previousSummary;
  }
  const prompt = buildPrompt(previousSummary, recentMessages);
  let text = "";
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      text = await summarizeViaAnthropicSdk(prompt);
    } else {
      text = await summarizeViaFallback(prompt, byokApiKey);
    }
  } catch {
    return previousSummary;
  }
  if (text.trim().length < MIN_USABLE_LENGTH) {
    return previousSummary;
  }
  return text.slice(0, MAX_SUMMARY_CHARS);
}
