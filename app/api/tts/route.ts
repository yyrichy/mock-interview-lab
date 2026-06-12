// Alex's voice. Two providers behind one contract (text in, audio/mpeg out):
//   - openai     — gpt-4o-mini-tts on the same metered OPENAI_API_KEY as the
//                  interviewer/feedback/transcription, so voice cost lives
//                  under the one spend cap with no separate quota cliff.
//   - elevenlabs — the original engine; better voices, but its own key and a
//                  hard monthly character quota. Kept for env/BYOK users.
// Selection: TTS_PROVIDER env override, else ElevenLabs when its key is set
// (back-compat with existing deployments), else OpenAI.

import { type NextRequest, NextResponse } from "next/server";

import {
  MissingProviderKeyError,
  resolveProviderKey,
} from "@/lib/resolve-provider-key";

export const runtime = "nodejs";

const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const DEFAULT_MODEL_ID = "eleven_flash_v2_5";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const MAX_TEXT_CHARS = 4500;

const OPENAI_TTS_DEFAULT_MODEL = "gpt-4o-mini-tts";
const OPENAI_TTS_DEFAULT_VOICE = "ash";
/** OpenAI /v1/audio/speech caps input at 4096 characters. */
const OPENAI_MAX_INPUT_CHARS = 4096;
const OPENAI_TTS_INSTRUCTIONS =
  "You are a calm, friendly senior software engineer conducting a technical interview. Natural conversational pace, plain delivery, no theatrics.";

type TtsRequestBody = {
  text?: unknown;
  voiceId?: unknown;
};

function resolveTtsProvider(): "openai" | "elevenlabs" {
  const explicit = process.env.TTS_PROVIDER?.trim().toLowerCase();
  if (explicit === "openai" || explicit === "elevenlabs") {
    return explicit;
  }
  // Back-compat: an ElevenLabs key in env keeps today's behavior unless
  // TTS_PROVIDER says otherwise.
  return process.env.ELEVENLABS_API_KEY ? "elevenlabs" : "openai";
}

function safeVoiceId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(trimmed) ? trimmed : null;
}

async function synthesizeViaOpenAi(
  req: NextRequest,
  text: string
): Promise<NextResponse> {
  // Same key policy as /api/transcribe: BYOK header preferred, but only when
  // its prefix matches OpenAI ("sk-…"); an ElevenLabs key ("sk_…") from the
  // client is dropped and the env var is used instead. Never logged.
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

  let openaiRes: Response;
  try {
    openaiRes = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || OPENAI_TTS_DEFAULT_MODEL,
        voice: process.env.OPENAI_TTS_VOICE || OPENAI_TTS_DEFAULT_VOICE,
        input: text.slice(0, OPENAI_MAX_INPUT_CHARS),
        instructions: OPENAI_TTS_INSTRUCTIONS,
        response_format: "mp3",
      }),
    });
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

  const audio = await openaiRes.arrayBuffer();
  return new NextResponse(audio, {
    headers: {
      "Content-Type": openaiRes.headers.get("content-type") ?? "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}

async function synthesizeViaElevenLabs(
  req: NextRequest,
  text: string,
  requestedVoiceId: unknown
): Promise<NextResponse> {
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

  const voiceId =
    safeVoiceId(requestedVoiceId) ??
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

export async function POST(req: NextRequest): Promise<NextResponse> {
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

  if (resolveTtsProvider() === "openai") {
    return synthesizeViaOpenAi(req, text);
  }
  return synthesizeViaElevenLabs(req, text, body.voiceId);
}
