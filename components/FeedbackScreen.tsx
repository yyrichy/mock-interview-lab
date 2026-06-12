"use client";

import Link from "next/link";
import { useState } from "react";

import { AssistantMessageBody } from "@/components/AssistantMessageBody";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SIGNED_UP_STORAGE_KEY = "ai-interviewer:signedUp";

function loadSignedUp(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return localStorage.getItem(SIGNED_UP_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function SignupCard({ questionId }: { questionId: string }) {
  const [email, setEmail] = useState("");
  const [suggestion, setSuggestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(loadSignedUp);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError("That doesn't look like an email address.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: trimmed,
          suggestion: suggestion.trim() || undefined,
          questionId,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error ?? `Signup failed (${res.status})`);
      }
      setDone(true);
      try {
        localStorage.setItem(SIGNED_UP_STORAGE_KEY, "1");
      } catch {
        /* private mode */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-lg border border-emerald-800/60 bg-emerald-950/30 p-5">
        <h3 className="text-sm font-semibold text-emerald-300">
          You&apos;re on the list
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-zinc-300">
          Thanks — you&apos;ll hear about new questions and features as they
          land.{" "}
          <Link
            href="/questions"
            className="text-emerald-300 underline decoration-emerald-800 underline-offset-4 transition hover:text-emerald-200"
          >
            Try another question
          </Link>{" "}
          in the meantime.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="rounded-lg border border-zinc-700 bg-zinc-900/70 p-5"
    >
      <h3 className="text-sm font-semibold text-zinc-100">
        Want more interviews like this?
      </h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-400">
        Leave your email and you&apos;ll hear when new questions, patterns, and
        features land. No spam — it&apos;s just me building this.
      </p>
      <label className="mt-4 block">
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Email
        </span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          required
          className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-600 focus:outline-none"
        />
      </label>
      <label className="mt-3 block">
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Anything feel off? What should be built next?{" "}
          <span className="normal-case text-zinc-600">(optional)</span>
        </span>
        <textarea
          value={suggestion}
          onChange={(e) => setSuggestion(e.target.value)}
          rows={4}
          maxLength={2000}
          placeholder="The follow-up question felt too easy… / I'd love system design rounds…"
          className="mt-1 w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-600 focus:outline-none"
        />
      </label>
      {error && (
        <p className="mt-2 text-[13px] text-red-400" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting || email.trim().length === 0}
        className="mt-4 w-full rounded-md border border-emerald-600/70 bg-emerald-950/40 px-3 py-2 text-sm font-medium text-emerald-100 transition hover:bg-emerald-900/50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Sending…" : "Keep me posted"}
      </button>
    </form>
  );
}

/**
 * Full-screen end-of-session view: the written scorecard on one side, email
 * capture + suggestions on the other. Replaces the editor/chat workspace once
 * sessionPhase reaches "feedback" — the scorecard is the payoff moment, so the
 * signup ask sits right next to it.
 */
export function FeedbackScreen({
  feedbackText,
  streaming,
  questionId,
  questionTitle,
}: {
  feedbackText: string;
  streaming: boolean;
  questionId: string;
  questionTitle: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <div className="min-w-0 flex-1 px-5 py-6 lg:overflow-y-auto lg:px-8">
        <h2 className="text-base font-semibold text-zinc-100">
          Your interview feedback
        </h2>
        <p className="mt-0.5 text-[12px] text-zinc-500">{questionTitle}</p>
        <div className="mt-5 max-w-3xl">
          {feedbackText.trim().length > 0 ? (
            <AssistantMessageBody content={feedbackText} />
          ) : streaming ? (
            <p className="text-sm text-zinc-400">
              Alex is writing up your feedback…
            </p>
          ) : (
            <p className="text-sm text-zinc-400">
              [No feedback was generated — try again or switch model.]
            </p>
          )}
          {streaming && feedbackText.trim().length > 0 && (
            <p className="mt-3 animate-pulse text-[12px] text-zinc-500">
              still writing…
            </p>
          )}
        </div>
      </div>
      <aside className="w-full shrink-0 border-t border-zinc-800 px-5 py-6 lg:w-[380px] lg:overflow-y-auto lg:border-l lg:border-t-0 lg:px-6">
        <SignupCard questionId={questionId} />
      </aside>
    </div>
  );
}
