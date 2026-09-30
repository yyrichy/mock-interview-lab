import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

const speechClip = readFileSync(
  path.join(process.cwd(), "e2e/fixtures/candidate-clarification.mp3")
).toString("base64");
const modelPresetId = "openrouter-qwen3.8-27b-free";

test("real interviewer holds a voice conversation through two turns", async ({
  page,
}) => {
  test.setTimeout(180_000);
  test.skip(
    !process.env.OPENROUTER_API_KEY,
    "Set OPENROUTER_API_KEY in .env.local to run the live conversation test"
  );

  const interviewerRequests: Array<{
    modelPresetId?: string;
    messages?: Array<{ content?: string; role?: string }>;
  }> = [];
  const ttsStatuses: number[] = [];

  await page.addInitScript((audioBase64) => {
    try {
      localStorage.setItem("mock-coding:alexVoice", "true");
    } catch {
      /* The test can still reach the app if storage is unavailable. */
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

  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/interviewer") &&
      request.method() === "POST"
    ) {
      const body = request.postDataJSON() as {
        modelPresetId?: string;
        messages?: Array<{ content?: string; role?: string }>;
      };
      interviewerRequests.push(body);
    }
  });
  page.on("response", (response) => {
    if (response.url().endsWith("/api/tts")) {
      ttsStatuses.push(response.status());
    }
  });

  await page.route("**/api/local-debug/session", async (route) => {
    await route.fulfill({ status: 200, body: "{}" });
  });

  await page.goto("/interview/two-sum");

  const messages = page.locator("aside ul > li");
  await expect
    .poll(async () => (await messages.first().innerText()).trim().length, {
      timeout: 120_000,
    })
    .toBeGreaterThan(30);
  await expect
    .poll(() => interviewerRequests.length, { timeout: 60_000 })
    .toBe(1);
  expect(interviewerRequests[0]?.modelPresetId).toBe(modelPresetId);
  const opening = await messages.first().innerText();
  expect(opening).not.toContain("[Error:");
  await expect
    .poll(() => ttsStatuses.length, { timeout: 60_000 })
    .toBeGreaterThan(0);
  expect(ttsStatuses[0]).toBe(200);
  console.log(`Live interviewer opening: ${opening.replace(/\s*Speak\s*$/, "")}`);

  const mic = page.getByRole("button", {
    name: /Hold to .*dictate a message/,
  });
  await expect(mic).toBeEnabled();
  const transcriptionResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/transcribe") &&
      response.request().method() === "POST",
    { timeout: 45_000 }
  );
  await mic.hover();
  await page.mouse.down();
  await expect(page.getByText("Recording… release to transcribe")).toBeVisible();
  await page.waitForTimeout(3_500);
  await page.mouse.up();

  const sttResponse = await transcriptionResponse;
  expect(sttResponse.status()).toBe(200);
  const transcription = (await sttResponse.json()) as { text?: string };
  const candidateTurn = transcription.text?.trim() ?? "";
  expect(candidateTurn.toLowerCase()).toContain("duplicate");
  expect(candidateTurn.toLowerCase()).toContain("values");

  await expect(messages).toHaveCount(3, { timeout: 90_000 });
  await expect(messages.nth(1)).toContainText(candidateTurn);
  await expect
    .poll(
      async () => (await messages.nth(2).innerText()).trim().length,
      { timeout: 90_000 }
    )
    .toBeGreaterThan(20);
  await expect
    .poll(() => interviewerRequests.length, { timeout: 60_000 })
    .toBe(2);

  const candidateRequest = interviewerRequests[1];
  expect(candidateRequest?.modelPresetId).toBe(modelPresetId);
  expect(
    candidateRequest?.messages?.some(
      (message) => message.role === "user" && message.content === candidateTurn
    )
  ).toBe(true);

  const followUp = await messages.nth(2).innerText();
  console.log(`Whisper heard: ${candidateTurn}`);
  console.log(`Live interviewer reply: ${followUp.replace(/\s*Speak\s*$/, "")}`);
});
