export type AiProvider = "gemini" | "groq" | "anthropic" | "openai" | "openrouter";

export type AiModelConfig = {
  provider: AiProvider;
  model: string;
};

export const AI_MODEL_PRESETS = {
  "openai-gpt-5.4-mini": {
    provider: "openai" as const,
    model: "gpt-5.4-mini",
  },
  "groq-llama-3.3-70b": {
    provider: "groq" as const,
    model: "llama-3.3-70b-versatile",
  },
  "anthropic-claude-sonnet-4-6": {
    provider: "anthropic" as const,
    model: "claude-sonnet-4-6",
  },
  "openrouter-north-mini-code-free": {
    provider: "openrouter" as const,
    model: "cohere/north-mini-code:free",
  },
} as const satisfies Record<string, AiModelConfig>;

export const GEMINI_RECOVERY_MODEL: AiModelConfig = {
  provider: "gemini",
  model: "gemini-3.1-flash-lite",
};

export type AiModelPresetId = keyof typeof AI_MODEL_PRESETS;

export const AI_MODEL_OPTIONS: ReadonlyArray<{
  id: AiModelPresetId;
  label: string;
}> = [
  {
    id: "openrouter-north-mini-code-free",
    label: "Cohere North Mini Code (free)",
  },
];

// North Mini Code is primary; Gemini 3.1 Flash-Lite is an automatic recovery
// model when the OpenRouter free endpoint is unavailable.
export const DEFAULT_AI_MODEL_PRESET_ID: AiModelPresetId =
  "openrouter-north-mini-code-free";

/** localStorage key for the interview model picker (survives refresh). */
export const AI_MODEL_PRESET_STORAGE_KEY = "mock-coding:modelPresetId";

export function isAiModelPresetId(id: string): id is AiModelPresetId {
  return id in AI_MODEL_PRESETS;
}

export function getAiModelConfig(id: string): AiModelConfig | null {
  if (!isAiModelPresetId(id)) {
    return null;
  }
  return AI_MODEL_PRESETS[id];
}
