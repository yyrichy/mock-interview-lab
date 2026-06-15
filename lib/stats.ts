// Launch funnel + rating counters, stored in the same Upstash Redis the
// rate-limit middleware and signup capture already use (no new vendor). Every
// helper is FAIL-OPEN and best-effort: with no Upstash env vars (local dev) or
// on any Redis error it silently no-ops, so analytics can never slow down or
// break an interview. Read the numbers via GET /api/stats (token-gated) or the
// Upstash console.

import { Redis } from "@upstash/redis";

const hasEnv =
  typeof process.env.UPSTASH_REDIS_REST_URL === "string" &&
  process.env.UPSTASH_REDIS_REST_URL.length > 0 &&
  typeof process.env.UPSTASH_REDIS_REST_TOKEN === "string" &&
  process.env.UPSTASH_REDIS_REST_TOKEN.length > 0;

const redis = hasEnv ? Redis.fromEnv() : null;

/** Fire-and-forget INCR on one or more counter keys. Never throws. */
export async function incrementStat(...keys: string[]): Promise<void> {
  if (!redis || keys.length === 0) {
    return;
  }
  try {
    await Promise.all(keys.map((k) => redis.incr(k)));
  } catch {
    /* fail-open — analytics must never break a request */
  }
}

/** Record a 1–5 star rating: bump count, running sum, and per-star distribution. */
export async function recordRating(value: number): Promise<void> {
  if (!redis) {
    return;
  }
  try {
    await Promise.all([
      redis.incr("rating:count"),
      redis.incrby("rating:sum", value),
      redis.incr(`rating:dist:${value}`),
    ]);
  } catch {
    /* fail-open */
  }
}

/**
 * Count of distinct signup emails (`signup:emails` set) — the landing-page
 * social-proof number. Fail-open 0 (no Redis / error → render nothing).
 */
export async function getSignupCount(): Promise<number> {
  if (!redis) {
    return 0;
  }
  try {
    return (await redis.scard("signup:emails")) ?? 0;
  } catch {
    return 0;
  }
}

export type LaunchStats = {
  sessionsStarted: number;
  sessionsFinished: number;
  signups: number;
  signupsBySource: { feedback: number; waitlist: number };
  ratingCount: number;
  ratingAvg: number | null;
  ratingDistribution: Record<1 | 2 | 3 | 4 | 5, number>;
};

/** Read the aggregate counters for GET /api/stats. Returns null if unconfigured/errored. */
export async function readLaunchStats(): Promise<LaunchStats | null> {
  if (!redis) {
    return null;
  }
  try {
    const [started, finished, ratingCount, ratingSum, d1, d2, d3, d4, d5] =
      await redis.mget<
        Array<number | null>
      >(
        "sessions:started",
        "sessions:finished",
        "rating:count",
        "rating:sum",
        "rating:dist:1",
        "rating:dist:2",
        "rating:dist:3",
        "rating:dist:4",
        "rating:dist:5"
      );
    const [signups, feedbackSignups, waitlistSignups] = await Promise.all([
      redis.scard("signup:emails"),
      redis.scard("signup:emails:feedback"),
      redis.scard("signup:emails:waitlist"),
    ]);
    const count = ratingCount ?? 0;
    const sum = ratingSum ?? 0;
    return {
      sessionsStarted: started ?? 0,
      sessionsFinished: finished ?? 0,
      signups: signups ?? 0,
      signupsBySource: {
        feedback: feedbackSignups ?? 0,
        waitlist: waitlistSignups ?? 0,
      },
      ratingCount: count,
      ratingAvg: count > 0 ? Math.round((sum / count) * 100) / 100 : null,
      ratingDistribution: {
        1: d1 ?? 0,
        2: d2 ?? 0,
        3: d3 ?? 0,
        4: d4 ?? 0,
        5: d5 ?? 0,
      },
    };
  } catch {
    return null;
  }
}
