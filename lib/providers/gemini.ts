import { GoogleGenerativeAI } from "@google/generative-ai";
import type { StreamChatOptions, ProviderMessage } from "./types";

function getApiKey(override?: string): string {
  const key = override ?? process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

function toGeminiHistory(messages: ProviderMessage[]) {
  const mapped = messages.map((m) => ({
    role: m.role === "user" ? ("user" as const) : ("model" as const),
    parts: [{ text: m.content }],
  }));

  if (mapped.length > 0 && mapped[0].role === "model") {
    return [
      {
        role: "user" as const,
        parts: [
          {
            text: "(Session start — the candidate is here for the interview. Continue from your opening message below.)",
          },
        ],
      },
      ...mapped,
    ];
  }

  return mapped;
}

export async function* streamChat(
  options: StreamChatOptions
): AsyncGenerator<string> {
  const genAI = new GoogleGenerativeAI(getApiKey(options.apiKey));
  const genModel = genAI.getGenerativeModel({
    model: options.model,
    systemInstruction: options.system,
  });

  const prior = options.messages.slice(0, -1);
  const last = options.messages[options.messages.length - 1];

  if (!last || last.role !== "user") {
    throw new Error("Last message must be from the user");
  }

  const chat = genModel.startChat({ history: toGeminiHistory(prior) });
  const result = await chat.sendMessageStream(last.content);

  for await (const chunk of result.stream) {
    let text: string;
    try {
      text = chunk.text();
    } catch {
      continue;
    }
    if (text) yield text;
  }
}
