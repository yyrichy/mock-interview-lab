import { NextResponse, type NextRequest } from "next/server";

import { parsePersistedInterviewSession } from "@/lib/interview-session-storage";
import { writeLocalInterviewSnapshot } from "@/lib/local-debug-archive";

export const runtime = "nodejs";

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;

function isSameOriginRequest(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_ARCHIVE_BYTES) {
    return NextResponse.json({ error: "Snapshot too large" }, { status: 413 });
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_ARCHIVE_BYTES) {
    return NextResponse.json({ error: "Snapshot too large" }, { status: 413 });
  }

  let questionId: string;
  try {
    const body: unknown = JSON.parse(raw);
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as Record<string, unknown>).questionId !== "string"
    ) {
      return NextResponse.json({ error: "Invalid snapshot" }, { status: 400 });
    }
    questionId = (body as Record<string, string>).questionId;
  } catch {
    return NextResponse.json({ error: "Invalid snapshot" }, { status: 400 });
  }

  const session = parsePersistedInterviewSession(raw, questionId);
  if (!session) {
    return NextResponse.json({ error: "Invalid snapshot" }, { status: 400 });
  }

  try {
    await writeLocalInterviewSnapshot(session);
    return NextResponse.json({ saved: true });
  } catch {
    return NextResponse.json(
      { error: "Could not write local interview archive" },
      { status: 500 }
    );
  }
}
