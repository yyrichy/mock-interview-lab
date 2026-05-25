export type ProviderMessage = { role: "user" | "assistant"; content: string };

export type StreamChatOptions = {
  system: string;
  messages: ProviderMessage[];
  model: string;
  /** Optional BYOK override — if present, used instead of the server env key. */
  apiKey?: string;
};
