import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const DEFAULT_MODEL_ID = "eleven_flash_v2_5";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const MAX_TEXT_CHARS = 4500;

type TtsRequestBody = {
  text?: unknown;
  voiceId?: unknown;
};

function safeVoiceId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(trimmed) ? trimmed : null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const apiKey =
    req.headers.get("x-provider-key") ?? process.env.ELEVENLABS_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "No ElevenLabs API key configured. Set ELEVENLABS_API_KEY in .env.local or add an ElevenLabs key via API Keys.",
      },
      { status: 500 }
    );
  }

  let body: TtsRequestBody;
  try {
    body = (await req.json()) as TtsRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    return NextResponse.json({ error: "Missing text" }, { status: 400 });
  }

  const text = body.text.trim().slice(0, MAX_TEXT_CHARS);
  const voiceId =
    safeVoiceId(body.voiceId) ??
    safeVoiceId(process.env.ELEVENLABS_VOICE_ID) ??
    DEFAULT_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID;

  let elevenLabsRes: Response;
  try {
    elevenLabsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${DEFAULT_OUTPUT_FORMAT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability: 0.48,
            similarity_boost: 0.78,
            style: 0.2,
            use_speaker_boost: true,
          },
        }),
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Network error: ${msg}` }, { status: 502 });
  }

  if (!elevenLabsRes.ok) {
    const errText = await elevenLabsRes.text().catch(() => "");
    return NextResponse.json(
      { error: errText || `ElevenLabs returned ${elevenLabsRes.status}` },
      { status: elevenLabsRes.status }
    );
  }

  const audio = await elevenLabsRes.arrayBuffer();
  return new NextResponse(audio, {
    headers: {
      "Content-Type":
        elevenLabsRes.headers.get("content-type") ?? "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
