import OpenAI from "openai";
import type { StreamChatOptions, ProviderMessage } from "./types";

function getApiKey(override?: string, baseURL?: string): string {
  const isOpenRouter = baseURL?.startsWith("https://openrouter.ai/") ?? false;
  const envVar = isOpenRouter ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY";
  const key = override ?? process.env[envVar];
  if (!key) throw new Error(`${envVar} is not set`);
  return key;
}

function toOpenAIMessages(
  messages: ProviderMessage[]
): Array<{ role: "user" | "assistant"; content: string }> {
  const mapped = messages.map((m) => ({
    role: m.role === "user" ? ("user" as const) : ("assistant" as const),
    content: m.content,
  }));

  if (mapped.length > 0 && mapped[0].role === "assistant") {
    return [
      {
        role: "user" as const,
        content:
          "(Session start — the candidate is here for the interview. Continue from your opening message below.)",
      },
      ...mapped,
    ];
  }

  return mapped;
}

export async function* streamChat(
  options: StreamChatOptions
): AsyncGenerator<string> {
  const client = new OpenAI({
    apiKey: getApiKey(options.apiKey, options.baseURL),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });

  const stream = await client.chat.completions.create({
    model: options.model,
    messages: [
      { role: "system", content: options.system },
      ...toOpenAIMessages(options.messages),
    ],
    stream: true,
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
}
