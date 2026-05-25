"use client";

import { getAiModelConfig } from "@/lib/ai-models";
import { loadProviderKeys } from "@/lib/byok";

/**
 * POST /api/ai and yield decoded UTF-8 chunks from the plain-text response body.
 * Automatically adds x-provider-key if the user has a local BYOK key for the active provider.
 *
 * Pass `signal` to cancel an in-flight stream (e.g. on unmount/navigation).
 * Aborting throws a `DOMException` named "AbortError" from the generator.
 */
export async function* streamAiApi(
  body: Record<string, unknown>,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const presetId = typeof body.modelPresetId === "string" ? body.modelPresetId : null;
  if (presetId) {
    const config = getAiModelConfig(presetId);
    if (config) {
      const keys = loadProviderKeys();
      const key = keys[config.provider];
      if (key) {
        headers["x-provider-key"] = key;
      }
    }
  }

  const res = await fetch("/api/ai", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = (await res.json()) as { error?: string };
      if (typeof data.error === "string" && data.error) {
        message = data.error;
      }
    } catch {
      try {
        const t = await res.text();
        if (t) {
          message = t;
        }
      } catch {
        /* ignore */
      }
    }
    throw new Error(message);
  }

  if (!res.body) {
    throw new Error("Empty response body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value.length > 0) {
        yield decoder.decode(value, { stream: true });
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) {
      yield tail;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
