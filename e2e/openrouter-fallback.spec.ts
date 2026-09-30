import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { expect, test } from "@playwright/test";

import { withGeminiRecovery } from "../lib/openrouter-fallback";

function fakeModel(
  provider: string,
  modelId: string,
  doStream: LanguageModelV3["doStream"]
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("doGenerate is not used in this test");
    },
    doStream,
  };
}

function streamOf(
  parts: LanguageModelV3StreamPart[]
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

test("retries a transient OpenRouter failure with the recovery model", async () => {
  let recoveryCalls = 0;
  const primary = fakeModel("openrouter", "cohere/north-mini-code:free", async () => {
    throw Object.assign(new Error("upstream rate limited"), { statusCode: 429 });
  });
  const recovery = fakeModel("google", "gemini-3.1-flash-lite", async () => {
    recoveryCalls += 1;
    return {
      stream: streamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "recovery-turn" },
        { type: "text-delta", id: "recovery-turn", delta: "Gemini recovered." },
        { type: "text-end", id: "recovery-turn" },
      ]),
    };
  });
  const wrapped = withGeminiRecovery(primary, recovery);

  const result = await wrapped.doStream({} as Parameters<LanguageModelV3["doStream"]>[0]);
  const reader = result.stream.getReader();
  const output: string[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (next.value.type === "text-delta") output.push(next.value.delta);
  }

  expect(recoveryCalls).toBe(1);
  expect(output.join("")).toBe("Gemini recovered.");
});

test("does not replay the turn if OpenRouter fails after output starts", async () => {
  let recoveryCalls = 0;
  const primary = fakeModel(
    "openrouter",
    "cohere/north-mini-code:free",
    async () => {
      let index = 0;
      const parts: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "partial-turn" },
        { type: "text-delta", id: "partial-turn", delta: "Partial." },
      ];
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          pull(controller) {
            const next = parts[index];
            if (next) {
              index += 1;
              controller.enqueue(next);
            } else {
              controller.error(
                Object.assign(new Error("upstream rate limited"), {
                  statusCode: 429,
                })
              );
            }
          },
        }),
      };
    }
  );
  const recovery = fakeModel("google", "gemini-3.1-flash-lite", async () => {
    recoveryCalls += 1;
    return { stream: streamOf([]) };
  });
  const wrapped = withGeminiRecovery(primary, recovery);
  const result = await wrapped.doStream({} as Parameters<LanguageModelV3["doStream"]>[0]);
  const reader = result.stream.getReader();
  const output: string[] = [];
  let streamError: unknown;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.type === "text-delta") output.push(next.value.delta);
    }
  } catch (error) {
    streamError = error;
  }

  expect(String(streamError)).toContain("upstream rate limited");
  expect(recoveryCalls).toBe(0);
  expect(output.join("")).toBe("Partial.");
});
