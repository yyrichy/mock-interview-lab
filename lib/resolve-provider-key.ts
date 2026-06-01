// Server-only: resolve the API key for a given AI provider, preferring a
// per-request BYOK header over the server env var. Mirrors the policy used by
// the legacy /api/ai route: the BYOK key is only honored when its prefix
// matches the requested provider, so an Anthropic key is never forwarded to
// Groq/OpenAI/Gemini and vice versa. Keys are never logged, persisted, or
// echoed — only a "key ignored" notice in dev when a prefix mismatch occurs.

import type { AiProvider } from "@/lib/ai-models";

const ENV_VAR: Record<AiProvider, string> = {
  groq: "GROQ_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

/**
 * Prefix heuristic — does this BYOK key plausibly belong to `provider`?
 * Used to refuse forwarding a key to the wrong provider's API.
 */
export function keyMatchesProvider(
  provider: AiProvider,
  key: string
): boolean {
  switch (provider) {
    case "groq":
      return key.startsWith("gsk_");
    case "anthropic":
      return key.startsWith("sk-ant-");
    case "openai":
      // OpenAI keys start with "sk-" but NOT "sk-ant-" (Anthropic).
      return key.startsWith("sk-") && !key.startsWith("sk-ant-");
    case "gemini":
      return key.startsWith("AIza");
    default: {
      const _exhaustive: never = provider;
      return Boolean(_exhaustive);
    }
  }
}

export class MissingProviderKeyError extends Error {
  readonly provider: AiProvider;
  readonly envVar: string;
  constructor(provider: AiProvider) {
    const envVar = ENV_VAR[provider];
    super(
      `No API key for ${provider}. Set ${envVar} in .env.local or paste a ${provider} key in the API Keys drawer.`
    );
    this.name = "MissingProviderKeyError";
    this.provider = provider;
    this.envVar = envVar;
  }
}

/**
 * Resolve the API key for `provider`. Prefers the BYOK `headerKey` when it is
 * present AND its prefix matches the provider; otherwise falls back to the env
 * var. Throws MissingProviderKeyError when neither yields a usable key.
 *
 * A prefix-mismatched header is ignored (dev log only) — same behavior the
 * Groq-only gate had before this became multi-provider.
 */
export function resolveProviderKey(
  provider: AiProvider,
  headerKey?: string
): { apiKey: string } {
  if (headerKey) {
    if (keyMatchesProvider(provider, headerKey)) {
      return { apiKey: headerKey };
    }
    if (process.env.NODE_ENV === "development") {
      // Never log the key itself — only that it was dropped for a mismatch.
      console.log(
        `[interviewer-agent] BYOK key ignored — prefix does not match provider "${provider}"`
      );
    }
  }

  const envKey = process.env[ENV_VAR[provider]];
  if (envKey) {
    return { apiKey: envKey };
  }

  throw new MissingProviderKeyError(provider);
}
