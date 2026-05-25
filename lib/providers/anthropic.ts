import Anthropic from "@anthropic-ai/sdk";
import type { StreamChatOptions, ProviderMessage } from "./types";

function getApiKey(override?: string): string {
  const key = override ?? process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  return key;
}

function toAnthropicMessages(
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
  const client = new Anthropic({ apiKey: getApiKey(options.apiKey) });

  const stream = await client.messages.create({
    model: options.model,
    max_tokens: 2048,
    // Cache the system prompt — it's static across turns for a given session
    system: [
      {
        type: "text",
        text: options.system,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: toAnthropicMessages(options.messages),
    stream: true,
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}
