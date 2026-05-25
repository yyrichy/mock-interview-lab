/**
 * Speech: Groq Whisper transcription + ElevenLabs text-to-speech.
 *
 * Web Speech API and local @xenova/transformers Whisper were removed —
 * the round-trip to Groq is more reliable and works the same across browsers.
 */
import { loadProviderKeys } from "@/lib/byok";

const ELEVENLABS_MAX_TEXT_CHARS = 2200;

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

/** Transcribe audio via Groq Whisper API (server-side, requires GROQ_API_KEY). */
export async function transcribeWithGroqWhisper(blob: Blob): Promise<string> {
  if (blob.size < 256) {
    return "";
  }
  const ext = blob.type.includes("mp4") ? "mp4" : "webm";
  const form = new FormData();
  form.append("file", blob, `audio.${ext}`);

  const headers: Record<string, string> = {};
  const keys = loadProviderKeys();
  if (keys.groq) {
    headers["x-provider-key"] = keys.groq;
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

/** Synthesize Alex's reply via ElevenLabs (server-side, requires ELEVENLABS_API_KEY). */
export async function synthesizeWithElevenLabs(text: string): Promise<Blob> {
  const speechText = prepareTextForSpeech(text);
  if (!speechText) {
    throw new Error("Nothing to speak.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const keys = loadProviderKeys();
  if (keys.elevenlabs) {
    headers["x-provider-key"] = keys.elevenlabs;
  }

  const res = await fetch("/api/tts", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: speechText }),
  });

  if (!res.ok) {
    let message = `ElevenLabs text-to-speech failed (${res.status})`;
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
