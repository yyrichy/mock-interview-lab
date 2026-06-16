import type { AiProvider } from "@/lib/ai-models";

export type ProviderKeyId = AiProvider | "elevenlabs";

export type ProviderKeys = Partial<Record<ProviderKeyId, string>>;

const STORAGE_KEY = "mock-coding:byok";

export function loadProviderKeys(): ProviderKeys {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as ProviderKeys;
  } catch {
    return {};
  }
}

export function saveProviderKeys(keys: ProviderKeys): void {
  try {
    const filtered = Object.fromEntries(
      Object.entries(keys).filter(([, v]) => v && v.trim())
    ) as ProviderKeys;
    if (Object.keys(filtered).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    }
  } catch {
    /* ignore */
  }
}
