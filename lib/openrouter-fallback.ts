import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";

export type ProviderFallbackInfo = {
  statusCode: number | null;
  reason: string;
};

function statusCodeFrom(error: unknown): number | null {
  const seen = new Set<object>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const value = current as Record<string, unknown>;
    const status = value.statusCode ?? value.status;
    if (typeof status === "number") return status;
    if (typeof status === "string" && /^\d{3}$/.test(status)) {
      return Number(status);
    }
    pending.push(value.cause, value.lastError);
    if (Array.isArray(value.errors)) pending.push(...value.errors);
  }
  return null;
}

function errorText(error: unknown): string {
  const seen = new Set<object>();
  const pending: unknown[] = [error];
  const messages: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const value = current as Record<string, unknown>;
    if (typeof value.message === "string") messages.push(value.message);
    pending.push(value.cause, value.lastError);
    if (Array.isArray(value.errors)) pending.push(...value.errors);
  }
  return messages.join(" ").toLowerCase();
}

export function getOpenRouterFallbackInfo(
  error: unknown
): ProviderFallbackInfo | null {
  const statusCode = statusCodeFrom(error);
  const message = errorText(error);
  const transientNetworkError =
    /fetch failed|network|econnreset|econnrefused|enotfound|etimedout|timed out|temporarily unavailable|overloaded|rate.?limit|openrouter_api_key is not set/.test(
      message
    );
  if (
    (statusCode !== null &&
      (statusCode === 408 || statusCode === 429 || statusCode >= 500)) ||
    transientNetworkError
  ) {
    return {
      statusCode,
      reason: statusCode === 429 ? "rate_limited" : "transient_provider_error",
    };
  }
  return null;
}

function isCandidateFacingPart(part: LanguageModelV3StreamPart): boolean {
  return (
    part.type === "text-start" ||
    part.type === "text-delta" ||
    part.type === "tool-input-start" ||
    part.type === "tool-input-delta" ||
    part.type === "tool-input-end" ||
    part.type === "tool-call" ||
    part.type === "reasoning-start" ||
    part.type === "reasoning-delta" ||
    part.type === "reasoning-end"
  );
}

/**
 * Retry a failed OpenRouter generation on Gemini before any output has been
 * emitted. Once text or a tool call has started, propagate the error instead
 * of duplicating part of the interview turn.
 */
export function withGeminiRecovery(
  primary: LanguageModelV3,
  recovery: LanguageModelV3,
  onRecovery?: (info: ProviderFallbackInfo) => void
): LanguageModelV3 {
  return wrapLanguageModel({
    model: primary,
    middleware: {
      specificationVersion: "v3",
      async wrapGenerate({ doGenerate, params }) {
        try {
          return await doGenerate();
        } catch (error) {
          const info = getOpenRouterFallbackInfo(error);
          if (!info) throw error;
          onRecovery?.(info);
          return recovery.doGenerate(params);
        }
      },
      async wrapStream({ doStream, params }) {
        let initial;
        try {
          initial = await doStream();
        } catch (error) {
          const info = getOpenRouterFallbackInfo(error);
          if (!info) throw error;
          onRecovery?.(info);
          return recovery.doStream(params);
        }

        let reader = initial.stream.getReader();
        let outputStarted = false;
        let recoveryAttempted = false;

        const stream = new ReadableStream<LanguageModelV3StreamPart>({
          async pull(controller) {
            while (true) {
              let item: ReadableStreamReadResult<LanguageModelV3StreamPart>;
              try {
                item = await reader.read();
              } catch (error) {
                const info = getOpenRouterFallbackInfo(error);
                if (!outputStarted && !recoveryAttempted && info) {
                  recoveryAttempted = true;
                  onRecovery?.(info);
                  try {
                    reader = (await recovery.doStream(params)).stream.getReader();
                    continue;
                  } catch (recoveryError) {
                    controller.error(recoveryError);
                    return;
                  }
                }
                controller.error(error);
                return;
              }

              if (item.done) {
                controller.close();
                return;
              }

              const part = item.value;
              if (part.type === "error") {
                const info = getOpenRouterFallbackInfo(part.error);
                if (!outputStarted && !recoveryAttempted && info) {
                  recoveryAttempted = true;
                  onRecovery?.(info);
                  try {
                    await reader.cancel(part.error);
                    reader = (await recovery.doStream(params)).stream.getReader();
                    continue;
                  } catch (recoveryError) {
                    controller.error(recoveryError);
                    return;
                  }
                }
              }

              if (isCandidateFacingPart(part)) outputStarted = true;
              controller.enqueue(part);
              return;
            }
          },
          async cancel(reason) {
            await reader.cancel(reason);
          },
        });

        return { ...initial, stream };
      },
    },
  });
}
