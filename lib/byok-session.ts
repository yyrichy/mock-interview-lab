// The visitor's own OpenAI key for BYOK / at-capacity mode. sessionStorage
// ONLY — ephemeral, per-tab. It is never written to localStorage and never sent
// to our server except as the per-request `x-provider-key` header, which the
// server prefers over its env key (see resolveProviderKey) and never logs or
// persists. Mirrors lib/byok.ts but with a deliberately shorter lifetime.

const SESSION_KEY = "ai-interviewer:byok-openai-session";

export function getSessionOpenAiKey(): string | null {
  try {
    if (typeof sessionStorage === "undefined") {
      return null;
    }
    const v = sessionStorage.getItem(SESSION_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function setSessionOpenAiKey(key: string): void {
  try {
    const trimmed = key.trim();
    if (trimmed) {
      sessionStorage.setItem(SESSION_KEY, trimmed);
    }
  } catch {
    /* private mode / unavailable — ignore */
  }
}

export function clearSessionOpenAiKey(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}
