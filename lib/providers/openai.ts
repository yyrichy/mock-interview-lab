import OpenAI from "openai";
import type { StreamChatOptions, ProviderMessage } from "./types";

function getApiKey(override?: string): string {
  const key = override ?? process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
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
  const client = new OpenAI({ apiKey: getApiKey(options.apiKey) });

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
