"use client";

import { getAiModelConfig, type AiProvider } from "@/lib/ai-models";
import { loadProviderKeys } from "@/lib/byok";
import { getSessionOpenAiKey } from "@/lib/byok-session";
import type { ChatMessage, TranscriptEntry } from "@/lib/chat";
import type { SessionState } from "@/lib/session-state";

/**
 * The BYOK key to forward as `x-provider-key` for a provider. In at-capacity
 * mode the visitor's OpenAI key lives in sessionStorage and must win for OpenAI
 * calls; otherwise fall back to the long-lived localStorage BYOK key.
 */
function clientKeyForProvider(provider: AiProvider): string | undefined {
  if (provider === "openai") {
    const sessionKey = getSessionOpenAiKey();
    if (sessionKey) {
      return sessionKey;
    }
  }
  return loadProviderKeys()[provider];
}

/**
 * POST /api/feedback and yield decoded UTF-8 chunks from the plain-text response
 * body. Automatically adds x-provider-key if the user has a local BYOK key for
 * the active provider. This is the only plain-text streaming client left — the
 * end-of-session scorecard. Every conversational turn uses streamInterviewerApi.
 *
 * Pass `signal` to cancel an in-flight stream (e.g. on unmount/navigation).
 * Aborting throws a `DOMException` named "AbortError" from the generator.
 */
export async function* streamFeedbackApi(
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
      const key = clientKeyForProvider(config.provider);
      if (key) {
        headers["x-provider-key"] = key;
      }
    }
  }

  const res = await fetch("/api/feedback", {
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

export type InterviewerDataEvent =
  | { type: "error"; message: string }
  | { type: "tool_result"; tool: string; result: unknown };

/**
 * POST /api/interviewer and yield text chunks from the Vercel AI SDK data
 * stream. Non-text events (error, tool_result) are surfaced via `onData`.
 *
 * Forwards the BYOK key for the preset's provider via `x-provider-key` (same
 * pattern as streamFeedbackApi). The server re-validates the key prefix against the
 * resolved provider, so a mismatched key is dropped server-side too.
 */
export async function* streamInterviewerApi(
  body: {
    sessionState: SessionState;
    messages: ChatMessage[];
    transcript: TranscriptEntry[];
    turnCount: number;
    modelPresetId: string;
  },
  onData: (event: InterviewerDataEvent) => void,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const config = getAiModelConfig(body.modelPresetId);
  if (config) {
    const key = clientKeyForProvider(config.provider);
    if (key) {
      headers["x-provider-key"] = key;
    }
  }

  const res = await fetch("/api/interviewer", {
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

  let buffer = "";

  // v6 wire format: SSE. Each event is `data: <JSON UIMessageChunk>\n\n`.
  // Text is delivered as `text-delta` chunks between `text-start`/`text-end`.
  // Custom server-side data parts are `{ type: "data-<name>", data: {...} }`
  // — our server emits `data-error` and `data-tool_result`.
  const handleEvent = function* (raw: string): Generator<string> {
    // SSE event may contain multiple lines (comments, "event:", "id:", etc.).
    // We only care about `data:` lines; concatenate their payloads.
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("data:")) {
        // Per SSE spec, strip an optional single leading space after the colon.
        const payload = line.slice(5);
        dataLines.push(payload.startsWith(" ") ? payload.slice(1) : payload);
      }
    }
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") return;
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    if (!chunk || typeof chunk !== "object" || !("type" in chunk)) return;
    const type = (chunk as { type: unknown }).type;
    if (type === "text-delta") {
      const delta = (chunk as { delta?: unknown }).delta;
      if (typeof delta === "string" && delta.length > 0) {
        yield delta;
      }
      return;
    }
    if (typeof type !== "string" || !type.startsWith("data-")) return;
    const data = (chunk as { data?: unknown }).data;
    if (!data || typeof data !== "object") return;
    if (type === "data-error") {
      const message = (data as { message?: unknown }).message;
      if (typeof message === "string") {
        onData({ type: "error", message });
      }
      return;
    }
    if (type === "data-tool_result") {
      const tool = (data as { tool?: unknown }).tool;
      const result = (data as { result?: unknown }).result;
      if (typeof tool === "string") {
        onData({ type: "tool_result", tool, result });
      }
      return;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line (\n\n).
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const out of handleEvent(event)) {
          yield out;
        }
        sep = buffer.indexOf("\n\n");
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) {
      buffer += tail;
    }
    if (buffer.length > 0) {
      for (const out of handleEvent(buffer)) {
        yield out;
      }
      buffer = "";
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
