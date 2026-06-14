// Token-gated readout of the launch funnel counters (started → finished →
// signups, plus rating avg/distribution). Gate: STATS_TOKEN env must be set
// AND match the `?token=` query (or x-stats-token header); otherwise 404 so
// the route's existence isn't even revealed. Not in the rate-limit matcher —
// low-volume, single operator.

import { readLaunchStats } from "@/lib/stats";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const expected = process.env.STATS_TOKEN;
  const provided =
    new URL(req.url).searchParams.get("token") ??
    req.headers.get("x-stats-token");
  if (!expected || provided !== expected) {
    return new Response("Not found", { status: 404 });
  }
  const stats = await readLaunchStats();
  if (stats === null) {
    return Response.json(
      { error: "Stats unavailable — Upstash not configured." },
      { status: 503 }
    );
  }
  const conversion = {
    startToFinish:
      stats.sessionsStarted > 0
        ? Math.round((stats.sessionsFinished / stats.sessionsStarted) * 1000) /
          10
        : null,
    finishToSignup:
      stats.sessionsFinished > 0
        ? Math.round((stats.signups / stats.sessionsFinished) * 1000) / 10
        : null,
  };
  return Response.json({ ...stats, conversionPct: conversion });
}
