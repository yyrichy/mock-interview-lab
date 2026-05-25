import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const apiKey =
    req.headers.get("x-provider-key") ?? process.env.GROQ_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "No Groq API key configured. Set GROQ_API_KEY in .env.local or add a Groq key via API Keys.",
      },
      { status: 500 }
    );
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
  const filename =
    blob instanceof File
      ? blob.name
      : blob.type.includes("mp4")
        ? "audio.mp4"
        : "audio.webm";

  const groqForm = new FormData();
  groqForm.append("file", blob, filename);
  groqForm.append("model", "whisper-large-v3-turbo");
  groqForm.append("language", "en");

  let groqRes: Response;
  try {
    groqRes = await fetch(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: groqForm,
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Network error: ${msg}` }, { status: 502 });
  }

  if (!groqRes.ok) {
    const errText = await groqRes.text().catch(() => "");
    return NextResponse.json(
      { error: errText || `Groq returned ${groqRes.status}` },
      { status: groqRes.status }
    );
  }

  const data = (await groqRes.json()) as { text?: string };
  return NextResponse.json({ text: data.text ?? "" });
}
