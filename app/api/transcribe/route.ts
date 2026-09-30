import { type NextRequest, NextResponse } from "next/server";

import {
  MissingProviderKeyError,
  resolveProviderKey,
} from "@/lib/resolve-provider-key";

export const runtime = "nodejs";

/** Reject oversized or non-audio uploads before spending an OpenAI call. */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Cheap header check first: drop oversized uploads before parsing the
  // multipart body or resolving a key.
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "invalid_audio" }, { status: 400 });
  }

  // BYOK OpenRouter is preferred for speech when supplied. OpenAI remains a
  // compatible fallback for existing users/deployments.
  const byokKey = req.headers.get("x-provider-key") ?? undefined;
  const provider =
    byokKey?.startsWith("sk-or-v1-") ||
    (!byokKey && process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY)
      ? "openrouter"
      : "openai";
  let apiKey: string;
  try {
    ({ apiKey } = resolveProviderKey(provider, byokKey));
  } catch (keyError) {
    if (keyError instanceof MissingProviderKeyError) {
      return NextResponse.json({ error: keyError.message }, { status: 500 });
    }
    throw keyError;
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const file = form.get("file");
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing audio file" }, { status: 400 });
  }

  const blob: Blob = file;

  // Only accept recognized audio containers (codec params stripped), and
  // re-check the decoded size in case Content-Length was absent or spoofed.
  const audioType = blob.type.split(";")[0].trim().toLowerCase();
  if (!ALLOWED_AUDIO_TYPES.has(audioType) || blob.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "invalid_audio" }, { status: 400 });
  }

  const filename =
    blob instanceof File
      ? blob.name
      : blob.type.includes("mp4")
        ? "audio.mp4"
        : "audio.webm";

  const transcriptionForm = new FormData();
  transcriptionForm.append("file", blob, filename);
  transcriptionForm.append(
    "model",
    provider === "openrouter"
      ? process.env.OPENROUTER_STT_MODEL || "openai/whisper-large-v3-turbo"
      : "gpt-4o-mini-transcribe"
  );
  transcriptionForm.append("language", "en");

  let transcriptionRes: Response;
  try {
    transcriptionRes = await fetch(
      provider === "openrouter"
        ? "https://openrouter.ai/api/v1/audio/transcriptions"
        : "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: transcriptionForm,
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Network error: ${msg}` }, { status: 502 });
  }

  if (!transcriptionRes.ok) {
    const errText = await transcriptionRes.text().catch(() => "");
    return NextResponse.json(
      { error: errText || `${provider} returned ${transcriptionRes.status}` },
      { status: transcriptionRes.status }
    );
  }

  // Default response_format is JSON: { text }. Return it unchanged so the
  // request/response contract with the client is identical to the Groq route.
  const data = (await transcriptionRes.json()) as { text?: string };
  return NextResponse.json({ text: data.text ?? "" });
}
