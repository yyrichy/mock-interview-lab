// Server-only: map an AiModelConfig + resolved API key to a Vercel AI SDK
// LanguageModel for the /api/interviewer agent route. Constructed per-request
// so a BYOK key can override the server env key without leaking across
// requests.
//
// Groq + OpenAI both go through createOpenAI, but Groq MUST use .chat() — the
// OpenAI Responses API (the bare `openai(model)` call) is not implemented by
// Groq's compatibility endpoint and breaks tool calling. OpenAI also uses
// .chat() here to keep tool-calling behavior consistent with the rest of the
// app.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

import type { AiModelConfig } from "@/lib/ai-models";

export function getInterviewerLanguageModel(
  config: AiModelConfig,
  apiKey: string
): LanguageModel {
  switch (config.provider) {
    case "groq":
      return createOpenAI({
        baseURL: "https://api.groq.com/openai/v1",
        apiKey,
      }).chat(config.model);
    case "openai":
      return createOpenAI({ apiKey }).chat(config.model);
    case "anthropic":
      return createAnthropic({ apiKey })(config.model);
    case "gemini":
      return createGoogleGenerativeAI({ apiKey })(config.model);
    default: {
      const _exhaustive: never = config.provider;
      throw new Error(`Unknown provider: ${String(_exhaustive)}`);
    }
  }
}
