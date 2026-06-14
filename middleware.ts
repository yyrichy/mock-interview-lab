// Per-IP rate limiting for the public API routes, applied at the middleware
// layer so the protected route files (/api/judge0, /api/transcribe, /api/tts —
// do-not-touch per AGENTS.md) stay untouched. Uses Upstash Redis over REST
// (edge-compatible). FAIL-OPEN by design: with no Upstash env vars (local
// dev) or on a Redis error, requests pass through — an Upstash outage must
// degrade to "no limiting", never take the demo down. App-level caps
// (TEST_RUNS_MAX, turn caps, output caps) still bound per-session cost
// underneath this.

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextResponse, type NextRequest } from "next/server";

const hasUpstashEnv =
  typeof process.env.UPSTASH_REDIS_REST_URL === "string" &&
  process.env.UPSTASH_REDIS_REST_URL.length > 0 &&
  typeof process.env.UPSTASH_REDIS_REST_TOKEN === "string" &&
  process.env.UPSTASH_REDIS_REST_TOKEN.length > 0;

const redis = hasUpstashEnv ? Redis.fromEnv() : null;

function makeLimiter(
  prefix: string,
  requests: number,
  window: Parameters<typeof Ratelimit.slidingWindow>[1]
): Ratelimit | null {
  if (!redis) {
    return null;
  }
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(requests, window),
    prefix: `rl:${prefix}`,
    analytics: false,
  });
}

// Per-IP, per-minute budgets. Human interview pacing is a few requests per
// minute per route; these are generous for one user and tight for a bot.
const llmLimiter = makeLimiter("llm", 15, "1 m"); // interviewer turns + feedback
const execLimiter = makeLimiter("exec", 12, "1 m"); // judge0 runs/submits
const speechLimiter = makeLimiter("speech", 40, "1 m"); // whisper chunks + tts
const signupLimiter = makeLimiter("signup", 5, "1 m");
const ratingLimiter = makeLimiter("rating", 10, "1 m");

function limiterForPath(pathname: string): Ratelimit | null {
  if (
    pathname.startsWith("/api/interviewer") ||
    pathname.startsWith("/api/feedback")
  ) {
    return llmLimiter;
  }
  if (pathname.startsWith("/api/judge0")) {
    return execLimiter;
  }
  if (
    pathname.startsWith("/api/transcribe") ||
    pathname.startsWith("/api/tts")
  ) {
    return speechLimiter;
  }
  if (pathname.startsWith("/api/signup")) {
    return signupLimiter;
  }
  if (pathname.startsWith("/api/rating")) {
    return ratingLimiter;
  }
  return null;
}

export async function middleware(req: NextRequest) {
  const limiter = limiterForPath(req.nextUrl.pathname);
  if (limiter === null) {
    return NextResponse.next();
  }
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  try {
    const { success, reset } = await limiter.limit(ip);
    if (!success) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((reset - Date.now()) / 1000)
      );
      return NextResponse.json(
        { error: "Too many requests — please slow down." },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfterSeconds) },
        }
      );
    }
  } catch {
    // Fail-open: Redis being unreachable must not block the interview.
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/api/interviewer",
    "/api/feedback",
    "/api/judge0",
    "/api/transcribe",
    "/api/tts",
    "/api/signup",
    "/api/rating",
  ],
};
