import { expect, test } from "@playwright/test";

function mockInterviewerStream(text: string): string {
  const id = "mock-interviewer-message";
  const chunks = [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
    { type: "finish", finishReason: "stop" },
  ];
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
}

test("push-to-talk uploads captured audio and sends the mocked transcript", async ({
  page,
}) => {
  const transcriptReplies = [
    "Can the input contain duplicate values?",
    "I would use a dictionary to track numbers I have already seen.",
  ];
  const interviewerReplies = [
    "Hi. Before you solve it, what would you like to clarify about the inputs?",
    "[->planning]\nNow describe your approach and its time and space complexity.",
    "Good. Which boundary case would you check first?",
  ];
  const uploadedAudioSizes: number[] = [];
  const interviewerRequests: Array<{
    modelPresetId?: string;
    messages?: Array<{ content?: string }>;
  }> = [];

  await page.addInitScript(() => {
    try {
      localStorage.setItem("mock-coding:alexVoice", "false");
    } catch {
      /* The test still works if browser storage is unavailable. */
    }
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const audioContext = new AudioContext();
        await audioContext.resume();
        const destination = audioContext.createMediaStreamDestination();
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        gain.gain.value = 0.08;
        oscillator.frequency.value = 440;
        oscillator.connect(gain);
        gain.connect(destination);
        oscillator.start();
        return destination.stream;
      },
    });
  });

  await page.route("**/api/transcribe", async (route) => {
    const request = route.request();
    const contentType = request.headers()["content-type"] ?? "";
    const audio = request.postDataBuffer();
    expect(request.method()).toBe("POST");
    expect(contentType).toContain("multipart/form-data");
    expect(audio).not.toBeNull();
    expect(audio?.byteLength ?? 0).toBeGreaterThan(256);
    uploadedAudioSizes.push(audio?.byteLength ?? 0);

    const text = transcriptReplies.shift();
    if (!text) {
      throw new Error("Unexpected extra transcription request");
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text }),
    });
  });

  await page.route("**/api/interviewer", async (route) => {
    const body = route.request().postDataJSON() as {
      modelPresetId?: string;
      messages?: Array<{ content?: string }>;
    };
    interviewerRequests.push(body);
    const reply = interviewerReplies.shift();
    if (!reply) {
      throw new Error("Unexpected extra interviewer request");
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      headers: { "x-vercel-ai-ui-message-stream": "v1" },
      body: mockInterviewerStream(reply),
    });
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

  await recordMockAudio(page, /Hold to dictate a message/);
  await expect(
    page.getByText("Can the input contain duplicate values?", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("Now describe your approach and its time and space complexity.", {
      exact: false,
    })
  ).toBeVisible();

  await recordMockAudio(page, /Hold to dictate a message/);
  await expect(
    page.getByText(
      "I would use a dictionary to track numbers I have already seen.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(
    page.getByText("Which boundary case would you check first?", {
      exact: false,
    })
  ).toBeVisible();
  await page.getByRole("button", { name: "Open editor to start coding" }).click();
  await expect(page.getByLabel("Coding phase elapsed")).toBeVisible();

  expect(uploadedAudioSizes).toHaveLength(2);
  expect(interviewerRequests).toHaveLength(3);
  expect(interviewerRequests[0]?.modelPresetId).toBe(
    "openrouter-north-mini-code-free"
  );
  expect(
    interviewerRequests[1]?.messages?.some((message) =>
      message.content?.includes("Can the input contain duplicate values?")
    )
  ).toBe(true);
  expect(
    interviewerRequests[2]?.messages?.some((message) =>
      message.content?.includes(
        "I would use a dictionary to track numbers I have already seen."
      )
    )
  ).toBe(true);
});

async function recordMockAudio(
  page: import("@playwright/test").Page,
  micName: RegExp
): Promise<void> {
  const mic = page.getByRole("button", { name: micName });
  await expect(mic).toBeEnabled();
  await mic.hover();
  await page.mouse.down();
  await expect(page.getByText("Recording… release to transcribe")).toBeVisible();
  await page.waitForTimeout(900);
  await page.mouse.up();
}
