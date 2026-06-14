// Star rating capture from the feedback screen. Anonymous and aggregate-only
// (count + sum + distribution) — no per-user identity. Best-effort: returns ok
// even when Upstash is unconfigured, because a lost rating must never surface
// an error on the payoff screen. Rate-limited per IP by middleware.ts.

import { recordRating } from "@/lib/stats";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body === null || typeof body !== "object") {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  const { rating } = body as { rating?: unknown };
  if (
    typeof rating !== "number" ||
    !Number.isInteger(rating) ||
    rating < 1 ||
    rating > 5
  ) {
    return Response.json(
      { error: "rating must be an integer 1–5" },
      { status: 400 }
    );
  }
  await recordRating(rating);
  return Response.json({ ok: true });
}
