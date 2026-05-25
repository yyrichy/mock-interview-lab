import type { ChatMessage } from "./chat";
import type { ProviderMessage } from "./providers/types";

export const CONTEXT_VERBATIM_TURNS = 6;

/**
 * Trim the chat history for a mid-session message call.
 *
 * Keeps the last CONTEXT_VERBATIM_TURNS user+assistant pairs verbatim.
 * When older messages exist and a rollingContext summary is available,
 * injects it as a synthetic exchange at the top so the model retains
 * earlier context without sending the full history every turn.
 *
 * @returns ProviderMessage[] ready to pass to streamFromProvider
 */
export function buildMessageContext(
  messages: ChatMessage[],
  rollingContext: string | null,
  maxTurns: number = CONTEXT_VERBATIM_TURNS
): ProviderMessage[] {
  const windowSize = maxTurns * 2;

  if (messages.length <= windowSize) {
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }

  const kept = messages.slice(-windowSize);
  const result: ProviderMessage[] = [];

  if (rollingContext) {
    result.push({
      role: "user",
      content: `[Earlier conversation summary — do not repeat or reference this label aloud:\n${rollingContext}]`,
    });
    result.push({ role: "assistant", content: "Understood." });
  }

  result.push(...kept.map((m) => ({ role: m.role, content: m.content })));
  return result;
}

/**
 * Returns the slice of messages that should be summarized (everything older
 * than the verbatim window). Returns null when no summary is needed.
 */
export function getMessagesToSummarize(
  messages: ChatMessage[],
  maxTurns: number = CONTEXT_VERBATIM_TURNS
): ChatMessage[] | null {
  const windowSize = maxTurns * 2;
  if (messages.length <= windowSize) return null;
  return messages.slice(0, -windowSize);
}
