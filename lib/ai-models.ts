export type AiProvider = "gemini" | "groq" | "anthropic" | "openai";

export type AiModelConfig = {
  provider: AiProvider;
  model: string;
};

export const AI_MODEL_PRESETS = {
  "gemini-2.5-flash": {
    provider: "gemini" as const,
    model: "gemini-2.5-flash",
  },
  "groq-llama-3.3-70b": {
    provider: "groq" as const,
    model: "llama-3.3-70b-versatile",
  },
  "groq-llama-3.1-8b": {
    provider: "groq" as const,
    model: "llama-3.1-8b-instant",
  },
  "anthropic-claude-sonnet-4-6": {
    provider: "anthropic" as const,
    model: "claude-sonnet-4-6",
  },
  "anthropic-claude-haiku-4-5": {
    provider: "anthropic" as const,
    model: "claude-haiku-4-5-20251001",
  },
  "openai-gpt-5": {
    provider: "openai" as const,
    model: "gpt-5",
  },
  "openai-gpt-5-mini": {
    provider: "openai" as const,
    model: "gpt-5-mini",
  },
  "openai-gpt-5.4-mini": {
    provider: "openai" as const,
    model: "gpt-5.4-mini",
  },
} as const satisfies Record<string, AiModelConfig>;

export type AiModelPresetId = keyof typeof AI_MODEL_PRESETS;

export const AI_MODEL_OPTIONS: ReadonlyArray<{
  id: AiModelPresetId;
  label: string;
}> = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "groq-llama-3.3-70b", label: "Groq Llama 3.3 70B" },
  { id: "groq-llama-3.1-8b", label: "Groq Llama 3.1 8B Instant" },
  { id: "anthropic-claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "anthropic-claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "openai-gpt-5", label: "OpenAI GPT-5" },
  { id: "openai-gpt-5-mini", label: "OpenAI GPT-5 Mini" },
  { id: "openai-gpt-5.4-mini", label: "OpenAI GPT-5.4 Mini" },
];

// Default interviewer model is OpenAI GPT-5.4 Mini — a strong, reliable
// structured tool-caller. The hosted demo is deployed with the builder's own
// OpenAI key, so the interview "just works" for signups: no BYOK friction, no
// weak-caller failures. Groq, Gemini, and Anthropic presets all remain
// SELECTABLE for self-hosters who BYOK — they are simply no longer the default.
// One artifact, two configs (see demo-default-swap.md). Matches the
// "default is GPT-5.4 Mini" claim in AGENTS.md / CLAUDE.md.
export const DEFAULT_AI_MODEL_PRESET_ID: AiModelPresetId = "openai-gpt-5.4-mini";

/** localStorage key for the interview model picker (survives refresh). */
export const AI_MODEL_PRESET_STORAGE_KEY = "ai-interviewer:modelPresetId";

/** Default cheap/fast model for utility calls (openers, closers, summaries). */
export const DEFAULT_UTILITY_MODEL_PRESET_ID: AiModelPresetId =
  "groq-llama-3.1-8b";

/** localStorage key for the utility model picker (survives refresh). */
export const UTILITY_MODEL_PRESET_STORAGE_KEY =
  "ai-interviewer:utilityModelPresetId";

export function isAiModelPresetId(id: string): id is AiModelPresetId {
  return id in AI_MODEL_PRESETS;
}

export function getAiModelConfig(id: string): AiModelConfig | null {
  if (!isAiModelPresetId(id)) {
    return null;
  }
  return AI_MODEL_PRESETS[id];
}
