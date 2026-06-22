"use client";

import Link from "next/link";
import { useState } from "react";

import { AssistantMessageBody } from "@/components/AssistantMessageBody";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SIGNED_UP_STORAGE_KEY = "mock-coding:signedUp";

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

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-7 w-7 transition-colors ${
        filled ? "text-amber-400" : "text-zinc-700"
      }`}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 17.27 6.18 21l1.64-7.03L2 9.24l7.19-.61L12 2l2.81 6.63 7.19.61-5.82 4.73L17.82 21z" />
    </svg>
  );
}

function RatingCard({ questionId }: { questionId: string }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [submitted, setSubmitted] = useState(false);

  async function pick(value: number) {
    if (submitted) {
      return;
    }
    setRating(value);
    setSubmitted(true);
    // Best-effort: a rating that fails to record must not surface an error on
    // the payoff screen. Fire and forget.
    try {
      await fetch("/api/rating", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: value, questionId }),
      });
    } catch {
      /* ignore */
    }
  }

  const shown = hover || rating;

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/70 p-5">
      <h3 className="text-sm font-semibold text-zinc-100">
        How was your interview?
      </h3>
      <div
        className="mt-3 flex items-center gap-1"
        role="radiogroup"
        aria-label="Rate your interview from 1 to 5 stars"
        onMouseLeave={() => setHover(0)}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            disabled={submitted}
            onMouseEnter={() => !submitted && setHover(n)}
            onClick={() => void pick(n)}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
            aria-checked={rating === n}
            role="radio"
            className="rounded p-0.5 disabled:cursor-default focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500"
          >
            <StarIcon filled={n <= shown} />
          </button>
        ))}
      </div>
      {submitted && (
        <p className="mt-2 text-[13px] text-zinc-400">
          Thanks for rating. It helps a lot.
        </p>
      )}
    </div>
  );
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
          source: "feedback",
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
          You&apos;ll hear about new questions and features as they land.{" "}
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
        Leave your email and you&apos;ll hear when new questions and features
        land. No spam.
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
          placeholder="e.g. the follow-up was too easy, or I'd love to see system design rounds"
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
        {submitting ? "Sending" : "Keep me posted"}
      </button>
    </form>
  );
}

/**
 * Full-screen end-of-session view: the written scorecard on one side, a star
 * rating + email capture on the other. Replaces the editor/chat workspace once
 * sessionPhase reaches "feedback". The scorecard is the payoff moment, so the
 * rating (1 click) and signup (typing) asks sit right next to it, lightest
 * commitment first.
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
        <Link
          href="/"
          className="mb-4 inline-flex items-center gap-1 text-[13px] text-zinc-400 underline decoration-zinc-700 underline-offset-4 transition hover:text-zinc-200"
        >
          ← Back to home
        </Link>
        <h2 className="text-base font-semibold text-zinc-100">
          Your interview feedback
        </h2>
        <p className="mt-0.5 text-[12px] text-zinc-500">{questionTitle}</p>
        <div className="mt-5 max-w-3xl">
          {feedbackText.trim().length > 0 ? (
            <AssistantMessageBody content={feedbackText} />
          ) : streaming ? (
            <p className="text-sm text-zinc-400">
              Alex is writing up your feedback.
            </p>
          ) : (
            <p className="text-sm text-zinc-400">
              No feedback was generated. Try again or switch model.
            </p>
          )}
          {streaming && feedbackText.trim().length > 0 && (
            <p className="mt-3 animate-pulse text-[12px] text-zinc-500">
              still writing
            </p>
          )}
        </div>
      </div>
      <aside className="w-full shrink-0 space-y-4 border-t border-zinc-800 px-5 py-6 lg:w-[380px] lg:overflow-y-auto lg:border-l lg:border-t-0 lg:px-6">
        <RatingCard questionId={questionId} />
        <SignupCard questionId={questionId} />
      </aside>
    </div>
  );
}
