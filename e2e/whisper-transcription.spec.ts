import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

const reference = "I will check the boundary cases before I code.";
const speechClip = readFileSync(
  path.join(process.cwd(), "e2e/fixtures/mock-interview-phrase.mp3")
).toString("base64");

test("push-to-talk sends generated speech through real OpenRouter Whisper", async ({
  page,
}) => {
  test.skip(
    !process.env.OPENROUTER_API_KEY,
    "Set OPENROUTER_API_KEY in .env.local to run the real Whisper integration test"
  );

  const interviewerReplies = [
    "Hi. Before you solve it, what would you like to clarify about the inputs?",
    "[->planning]\nThanks. Now describe your approach and complexity.",
  ];
  const interviewerRequests: Array<{
    messages?: Array<{ content?: string; role?: string }>;
  }> = [];

  await page.addInitScript((audioBase64) => {
    try {
      localStorage.setItem("mock-coding:alexVoice", "false");
    } catch {
      /* The test still works if browser storage is unavailable. */
    }
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const audioContext = new AudioContext();
        const binary = atob(audioBase64);
        const bytes = Uint8Array.from(binary, (character) =>
          character.charCodeAt(0)
        );
        const audioBuffer = await audioContext.decodeAudioData(bytes.buffer);
        const destination = audioContext.createMediaStreamDestination();
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(destination);
        await audioContext.resume();
        source.start();
        return destination.stream;
      },
    });
  }, speechClip);

  await page.route("**/api/interviewer", async (route) => {
    const body = route.request().postDataJSON() as {
      messages?: Array<{ content?: string; role?: string }>;
    };
    interviewerRequests.push(body);
    const reply = interviewerReplies.shift();
    if (!reply) {
      throw new Error("Unexpected extra interviewer request");
    }
    const id = "mock-interviewer-message";
    const chunks = [
      { type: "text-start", id },
      { type: "text-delta", id, delta: reply },
      { type: "text-end", id },
      { type: "finish", finishReason: "stop" },
    ];
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      headers: { "x-vercel-ai-ui-message-stream": "v1" },
      body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""),
    });
  });
  await page.route("**/api/transcribe", async (route) => {
    const contentType = route.request().headers()["content-type"] ?? "";
    const audio = route.request().postDataBuffer();
    expect(contentType).toContain("multipart/form-data");
    expect(audio?.byteLength ?? 0).toBeGreaterThan(256);
    await route.continue();
  });
  await page.route("**/api/tts", async (route) => {
    await route.fulfill({ status: 500, body: "TTS is disabled in this test" });
  });
  await page.route("**/api/local-debug/session", async (route) => {
    await route.fulfill({ status: 200, body: "{}" });
  });

  await page.goto("/interview/two-sum");
  await expect(
    page.getByText("Before you solve it, what would you like to clarify", {
      exact: false,
    })
  ).toBeVisible();

  const transcriptionResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/transcribe") && response.request().method() === "POST",
    { timeout: 45_000 }
  );
  await recordSpeechClip(page);
  const response = await transcriptionResponse;
  expect(response.status()).toBe(200);

  const result = (await response.json()) as { text?: string };
  const transcript = result.text?.trim() ?? "";
  const errorRate = wordErrorRate(reference, transcript);
  console.log(`Whisper transcript: ${transcript}`);
  console.log(`Word error rate on generated sample: ${errorRate.toFixed(2)}`);
  expect(transcript).not.toBe("");
  expect(errorRate).toBeLessThanOrEqual(0.3);
  await expect(page.getByText(transcript, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Thanks. Now describe your approach and complexity.", {
      exact: false,
    })
  ).toBeVisible();
  expect(interviewerRequests).toHaveLength(2);
  expect(
    interviewerRequests[1]?.messages?.some(
      (message) => message.role === "user" && message.content === transcript
    )
  ).toBe(true);
});

function normalizeWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function wordErrorRate(expected: string, actual: string): number {
  const referenceWords = normalizeWords(expected);
  const actualWords = normalizeWords(actual);
  let previous = Array.from(
    { length: actualWords.length + 1 },
    (_, index) => index
  );

  for (let row = 1; row <= referenceWords.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= actualWords.length; column += 1) {
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! +
          (referenceWords[row - 1] === actualWords[column - 1] ? 0 : 1)
      );
    }
    previous = current;
  }

  return previous[actualWords.length]! / referenceWords.length;
}

async function recordSpeechClip(page: import("@playwright/test").Page) {
  const mic = page.getByRole("button", { name: /Hold to dictate a message/ });
  await expect(mic).toBeEnabled();
  await mic.hover();
  await page.mouse.down();
  await expect(page.getByText("Recording… release to transcribe")).toBeVisible();
  await page.waitForTimeout(3_600);
  await page.mouse.up();
}
