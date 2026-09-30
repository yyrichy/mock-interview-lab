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
  "gemini-2.5-flash": {
    provider: "gemini" as const,
    model: "gemini-2.5-flash",
  },
  "anthropic-claude-sonnet-4-6": {
    provider: "anthropic" as const,
    model: "claude-sonnet-4-6",
  },
  "openrouter-qwen3.8-27b-free": {
    provider: "openrouter" as const,
    model: "qwen/qwen3.8-27b:free",
  },
} as const satisfies Record<string, AiModelConfig>;

export type AiModelPresetId = keyof typeof AI_MODEL_PRESETS;

export const AI_MODEL_OPTIONS: ReadonlyArray<{
  id: AiModelPresetId;
  label: string;
}> = [
  { id: "openai-gpt-5.4-mini", label: "OpenAI GPT-5.4 Mini" },
  { id: "groq-llama-3.3-70b", label: "Groq Llama 3.3 70B" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "anthropic-claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "openrouter-qwen3.8-27b-free", label: "Qwen3.8 27B (free; avoid sensitive data)" },
];

// Default to the OpenRouter Qwen preset used by the local interview setup.
// Self-hosters need OPENROUTER_API_KEY (or a key in the API Keys drawer).
export const DEFAULT_AI_MODEL_PRESET_ID: AiModelPresetId =
  "openrouter-qwen3.8-27b-free";

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
