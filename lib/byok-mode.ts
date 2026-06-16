// Server-only BYOK ("bring your own key") fallback-mode flag. When ON, the
// hosted demo is "at capacity": new visitors are routed to /at-capacity to
// paste their own OpenAI key or join the waitlist, instead of spending the
// builder's metered key. Stored in the same Upstash Redis the rate limiter,
// signup capture, and stats already use — no new infra. FAIL-OPEN: any missing
// env / Redis error resolves to OFF so normal users are never blocked.

import { Redis } from "@upstash/redis";

const hasEnv =
  typeof process.env.UPSTASH_REDIS_REST_URL === "string" &&
  process.env.UPSTASH_REDIS_REST_URL.length > 0 &&
  typeof process.env.UPSTASH_REDIS_REST_TOKEN === "string" &&
  process.env.UPSTASH_REDIS_REST_TOKEN.length > 0;

const redis = hasEnv ? Redis.fromEnv() : null;

/** Interview starts (`sessions:started`) after which the demo flips to BYOK. */
function sessionThreshold(): number | null {
  const raw = process.env.BYOK_SESSION_THRESHOLD?.trim();
  if (!raw) {
    return null;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const BYOK_MODE_KEY = "byok:mode";
const SESSIONS_STARTED_KEY = "sessions:started";

// Short in-process cache so hot paths (interview page load, opening-turn gate)
// don't read Redis on every call. setByokMode invalidates it.
const CACHE_TTL_MS = 30_000;
let cached: { value: boolean; expiresAt: number } | null = null;

/** BYOK_MODE env override for emergencies: on/off forces the flag either way. */
function envOverride(): boolean | null {
  const raw = process.env.BYOK_MODE?.trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (raw === "on" || raw === "true" || raw === "1") {
    return true;
  }
  if (raw === "off" || raw === "false" || raw === "0") {
    return false;
  }
  return null;
}

function toNumber(v: unknown): number {
  if (typeof v === "number") {
    return v;
  }
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Is the demo in BYOK / at-capacity mode? Precedence:
 *   1. BYOK_MODE env override (emergency on/off)
 *   2. Redis `byok:mode` flag (latched by the quota auto-trip)
 *   3. `sessions:started` >= BYOK_SESSION_THRESHOLD env (skipped when unset)
 * Fail-open OFF — no Redis or any error means normal users are unaffected.
 */
export async function getByokMode(): Promise<boolean> {
  const override = envOverride();
  if (override !== null) {
    return override;
  }

  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let value = false;
  if (redis) {
    try {
      const [flag, started] = await Promise.all([
        redis.get<unknown>(BYOK_MODE_KEY),
        redis.get<unknown>(SESSIONS_STARTED_KEY),
      ]);
      const flagged =
        flag === true || flag === 1 || flag === "1" || flag === "true";
      const threshold = sessionThreshold();
      value =
        flagged ||
        (threshold !== null && toNumber(started) >= threshold);
    } catch {
      value = false; // fail-open
    }
  }
  cached = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/**
 * Latch BYOK mode on (e.g. after an OpenAI insufficient_quota error) or off.
 * Best-effort and fail-open — never throws, never blocks a request.
 */
export async function setByokMode(active: boolean): Promise<void> {
  if (!redis) {
    return;
  }
  try {
    if (active) {
      await redis.set(BYOK_MODE_KEY, "1");
    } else {
      await redis.del(BYOK_MODE_KEY);
    }
    cached = null; // invalidate so the change is seen on the next read
  } catch {
    /* fail-open */
  }
}
