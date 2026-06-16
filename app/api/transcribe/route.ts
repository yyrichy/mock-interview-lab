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

  // Same key policy as /api/interviewer: a BYOK OpenAI key (x-provider-key,
  // prefix-validated) is preferred over the OPENAI_API_KEY env var; a
  // mismatched header key is ignored, never logged or persisted.
  const byokKey = req.headers.get("x-provider-key") ?? undefined;
  let apiKey: string;
  try {
    ({ apiKey } = resolveProviderKey("openai", byokKey));
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

  const openaiForm = new FormData();
  openaiForm.append("file", blob, filename);
  openaiForm.append("model", "gpt-4o-mini-transcribe");
  openaiForm.append("language", "en");

  let openaiRes: Response;
  try {
    openaiRes = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: openaiForm,
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Network error: ${msg}` }, { status: 502 });
  }

  if (!openaiRes.ok) {
    const errText = await openaiRes.text().catch(() => "");
    return NextResponse.json(
      { error: errText || `OpenAI returned ${openaiRes.status}` },
      { status: openaiRes.status }
    );
  }

  // Default response_format is JSON: { text }. Return it unchanged so the
  // request/response contract with the client is identical to the Groq route.
  const data = (await openaiRes.json()) as { text?: string };
  return NextResponse.json({ text: data.text ?? "" });
}
