import type { StreamChatOptions, ProviderMessage } from "./types";

function getApiKey(override?: string): string {
  const key = override ?? process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not set");
  return key;
}

function toGroqMessages(
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
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey(options.apiKey)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      messages: [
        { role: "system", content: options.system },
        ...toGroqMessages(options.messages),
      ],
      stream: true,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(errBody.trim() || `Groq request failed (${res.status})`);
  }

  if (!res.body) {
    throw new Error("Groq response had no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;
      if (!trimmed.startsWith("data: ")) continue;
      const jsonStr = trimmed.slice(6);
      try {
        const parsed = JSON.parse(jsonStr) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {
        continue;
      }
    }
  }

  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
      const jsonStr = trimmed.slice(6);
      try {
        const parsed = JSON.parse(jsonStr) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {
        /* ignore trailing parse errors */
      }
    }
  }
}
