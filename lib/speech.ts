/**
 * Speech: OpenAI Whisper transcription + ElevenLabs text-to-speech.
 *
 * Web Speech API and local @xenova/transformers Whisper were removed —
 * the server round-trip is more reliable and works the same across browsers.
 */
import { loadProviderKeys } from "@/lib/byok";

const ELEVENLABS_MAX_TEXT_CHARS = 2200;

/** ElevenLabs API keys are prefixed "sk_" (distinct from OpenAI's "sk-"). */
const ELEVENLABS_KEY_PREFIX = "sk_";

const CODE_OPERATOR_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/\s*===\s*/g, " is strictly equal to "],
  [/\s*!==\s*/g, " is not strictly equal to "],
  [/\s*==\s*/g, " equals "],
  [/\s*!=\s*/g, " does not equal "],
  [/\s*<=\s*/g, " is less than or equal to "],
  [/\s*>=\s*/g, " is greater than or equal to "],
  [/\s*->\s*/g, " points to "],
  [/\s*=>\s*/g, " maps to "],
  [/\s*&&\s*/g, " and "],
  [/\s*\|\|\s*/g, " or "],
  [/\s+%\s+/g, " modulo "],
  [/\s+\+\s+/g, " plus "],
  [/\s+-\s+/g, " minus "],
  [/\s+\*\s+/g, " times "],
  [/\s+\/\s+/g, " divided by "],
  [/\s*=\s*/g, " equals "],
  [/\s*<\s*/g, " is less than "],
  [/\s*>\s*/g, " is greater than "],
];

function verbalizeListItems(value: string): string {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" and ");
}

function verbalizeCodeText(value: string): string {
  let spoken = value;

  // Common interview notation: array[i] is spoken as "array of i".
  spoken = spoken.replace(
    /\b([A-Za-z_$][\w$]*)\s*\[\s*([A-Za-z_$][\w$]*|\d+)\s*\]/g,
    "$1 of $2"
  );

  // Array literals in problem statements, e.g. [ai, bi].
  spoken = spoken.replace(/\[\s*([^\[\]]{1,120}?)\s*\]/g, (_, inner: string) => {
    const items = verbalizeListItems(inner);
    return items ? ` list containing ${items} ` : " empty list ";
  });

  // Function-style notation such as dfs(course), but leave prose parentheses alone.
  spoken = spoken.replace(
    /\b([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*|\d+)\s*\)/g,
    "$1 of $2"
  );

  for (const [pattern, replacement] of CODE_OPERATOR_REPLACEMENTS) {
    spoken = spoken.replace(pattern, replacement);
  }

  return spoken
    .replace(/[{}]/g, " ")
    .replace(/[()]/g, " ")
    .replace(/[:,;]/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return "";
}

export function isMediaRecorderCaptureSupported(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return (
    pickRecorderMimeType().length > 0 &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

/**
 * Transcribe audio via /api/transcribe (OpenAI Whisper server-side; uses
 * OPENAI_API_KEY env, or a BYOK OpenAI key forwarded below). Name kept for the
 * existing callers — the swap to OpenAI is transparent to them.
 */
export async function transcribeWithGroqWhisper(blob: Blob): Promise<string> {
  if (blob.size < 256) {
    return "";
  }
  const ext = blob.type.includes("mp4") ? "mp4" : "webm";
  const form = new FormData();
  form.append("file", blob, `audio.${ext}`);

  const headers: Record<string, string> = {};
  const keys = loadProviderKeys();
  // BYOK: a localStorage OpenAI key powers transcription on the user's account.
  if (keys.openai) {
    headers["x-provider-key"] = keys.openai;
  }

  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers,
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Groq transcription failed (${res.status})`);
  }
  const data = (await res.json()) as { text?: string };
  return typeof data.text === "string" ? data.text.trim() : "";
}

export function prepareTextForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " I will skip reading the code block aloud. ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, (_, code: string) => verbalizeCodeText(code))
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .split("\n")
    .map((line) => verbalizeCodeText(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ELEVENLABS_MAX_TEXT_CHARS);
}

/**
 * Synthesize Alex's reply via /api/tts. The server picks the engine (OpenAI
 * gpt-4o-mini-tts on the metered key, or ElevenLabs when configured); the
 * BYOK ElevenLabs header is only honored by the ElevenLabs branch.
 */
export async function synthesizeAlexVoice(text: string): Promise<Blob> {
  const speechText = prepareTextForSpeech(text);
  if (!speechText) {
    throw new Error("Nothing to speak.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const keys = loadProviderKeys();
  // Forward the BYOK OpenAI key for OpenAI TTS (the default engine); fall back
  // to a BYOK ElevenLabs key for the ElevenLabs engine.
  if (keys.openai) {
    headers["x-provider-key"] = keys.openai;
  } else if (keys.elevenlabs && keys.elevenlabs.startsWith(ELEVENLABS_KEY_PREFIX)) {
    // Mirror the server guard: only forward a key that looks like ElevenLabs'.
    headers["x-provider-key"] = keys.elevenlabs;
  }

  const res = await fetch("/api/tts", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: speechText }),
  });

  if (!res.ok) {
    let message = `Text-to-speech failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (typeof data.error === "string" && data.error) {
        message = data.error;
      }
    } catch {
      const textBody = await res.text().catch(() => "");
      if (textBody) {
        message = textBody;
      }
    }
    throw new Error(message);
  }

  return res.blob();
}
