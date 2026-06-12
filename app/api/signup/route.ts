// Email capture for the launch signup metric. Stores entries in Upstash Redis
// (same instance the rate-limit middleware uses — no extra infra). Emails are
// deduplicated via a set; every submission (including repeat emails carrying a
// new suggestion) is appended to a list so no feedback text is ever lost.
// Rate-limited per IP by middleware.ts like the other public routes.

import { Redis } from "@upstash/redis";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUGGESTION_MAX_LENGTH = 2000;

export async function POST(req: Request) {
  if (
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN
  ) {
    return Response.json(
      { error: "Signups are not configured on this deployment." },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body === null || typeof body !== "object") {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  const { email, suggestion, questionId } = body as {
    email?: unknown;
    suggestion?: unknown;
    questionId?: unknown;
  };
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    return Response.json({ error: "Invalid email address" }, { status: 400 });
  }
  if (suggestion !== undefined && typeof suggestion !== "string") {
    return Response.json(
      { error: "suggestion must be a string" },
      { status: 400 }
    );
  }
  const normalizedEmail = email.trim().toLowerCase();
  const entry = {
    email: normalizedEmail,
    suggestion:
      typeof suggestion === "string"
        ? suggestion.trim().slice(0, SUGGESTION_MAX_LENGTH)
        : "",
    questionId: typeof questionId === "string" ? questionId : null,
    at: new Date().toISOString(),
  };

  try {
    const redis = Redis.fromEnv();
    const added = await redis.sadd("signup:emails", normalizedEmail);
    await redis.lpush("signup:entries", JSON.stringify(entry));
    return Response.json({ ok: true, alreadySignedUp: added === 0 });
  } catch {
    // Never leak Redis/config details to the client.
    return Response.json(
      { error: "Could not save your signup — please try again." },
      { status: 502 }
    );
  }
}
