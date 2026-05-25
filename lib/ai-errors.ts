import type { AiProvider } from "@/lib/ai-models";

type ProviderEnv = {
  envVar: string;
  label: string;
};

const PROVIDER_INFO: Record<AiProvider, ProviderEnv> = {
  gemini: { envVar: "GEMINI_API_KEY", label: "Gemini" },
  groq: { envVar: "GROQ_API_KEY", label: "Groq" },
  anthropic: { envVar: "ANTHROPIC_API_KEY", label: "Anthropic" },
  openai: { envVar: "OPENAI_API_KEY", label: "OpenAI" },
};

/**
 * Map provider/SDK failures to HTTP status and a concise client message.
 * Pass `context.provider` so messages can name the active provider and the
 * correct env var / BYOK drawer hint.
 */
export function toClientAiFailure(
  e: unknown,
  context?: { provider?: AiProvider }
): { message: string; status: number } {
  const raw = extractErrorChainMessage(e);
  const status = inferHttpStatus(e, raw);
  const provider =
    context?.provider ?? inferProviderFromMessage(raw) ?? null;
  const info = provider != null ? PROVIDER_INFO[provider] : null;

  if (status === 429) {
    if (info != null) {
      return {
        status: 429,
        message: `${info.label} API quota or rate limit reached. Wait and retry, check the provider dashboard for billing/usage, or switch to a different model in the Model menu.`,
      };
    }
    return {
      status: 429,
      message:
        "AI provider quota or rate limit reached. Wait and retry, check the provider dashboard, or switch to a different model in the Model menu.",
    };
  }

  if (status === 401 || status === 403) {
    if (info != null) {
      return {
        status,
        message: `${info.label} rejected the request (invalid or unauthorized key). Check ${info.envVar} in .env.local, or paste a key in the API Keys drawer.`,
      };
    }
    return {
      status,
      message:
        "API rejected the request (invalid or unauthorized key). Check the relevant *_API_KEY in .env.local, or paste a key in the API Keys drawer.",
    };
  }

  const trimmed = raw.replace(/\s+/g, " ").trim();
  const short =
    trimmed.length > 320 ? `${trimmed.slice(0, 317)}…` : trimmed;
  const prefix = info != null ? `${info.label}: ` : "";

  return {
    status: status >= 400 && status < 600 ? status : 502,
    message: `${prefix}${short || "The AI provider returned an error."}`,
  };
}

function inferProviderFromMessage(message: string): AiProvider | null {
  const m = message.toLowerCase();
  if (/anthropic|claude/.test(m)) return "anthropic";
  if (/openai|gpt-/.test(m)) return "openai";
  if (/gemini|googleai|generativelanguage|google ai/.test(m)) return "gemini";
  if (/groq/.test(m)) return "groq";
  return null;
}

function extractErrorChainMessage(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  const seen = new Set<unknown>();
  let depth = 0;
  while (cur != null && depth < 5) {
    if (seen.has(cur)) {
      break;
    }
    seen.add(cur);
    if (cur instanceof Error && cur.message) {
      parts.push(cur.message);
    } else if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    cur =
      typeof cur === "object" && cur !== null && "cause" in cur
        ? (cur as { cause: unknown }).cause
        : null;
    depth += 1;
  }
  return parts.join(" — ");
}

function inferHttpStatus(e: unknown, message: string): number {
  let cur: unknown = e;
  const seen = new Set<unknown>();
  let depth = 0;
  while (cur != null && depth < 5) {
    if (seen.has(cur)) {
      break;
    }
    seen.add(cur);
    if (
      typeof cur === "object" &&
      cur !== null &&
      "status" in cur &&
      typeof (cur as { status: unknown }).status === "number"
    ) {
      const s = (cur as { status: number }).status;
      if (s >= 400 && s < 600) {
        return s;
      }
    }
    cur =
      typeof cur === "object" && cur !== null && "cause" in cur
        ? (cur as { cause: unknown }).cause
        : null;
    depth += 1;
  }
  if (/\b429\b/.test(message) || /Too Many Requests/i.test(message)) {
    return 429;
  }
  if (/\b401\b/.test(message) || /UNAUTHENTICATED/i.test(message)) {
    return 401;
  }
  if (/\b403\b/.test(message) || /PERMISSION_DENIED/i.test(message)) {
    return 403;
  }
  return 502;
}
