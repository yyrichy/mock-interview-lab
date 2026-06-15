"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { loadProviderKeys, saveProviderKeys } from "@/lib/byok";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Same prefix heuristic the server uses (resolveProviderKey.keyMatchesProvider),
// inlined to keep this client component free of the server-only key module.
function isLikelyOpenAiKey(key: string): boolean {
  const k = key.trim();
  return k.startsWith("sk-") && !k.startsWith("sk-ant-") && k.length >= 20;
}

/**
 * Shown when the demo is at capacity (BYOK mode). Two paths: keep going on your
 * own OpenAI key (stored in sessionStorage only, never on our server), or leave
 * an email for the waitlist. `questionId` is validated server-side before it
 * reaches here, so the "start" link is safe.
 */
export function AtCapacity({ questionId }: { questionId: string }) {
  const router = useRouter();

  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [suggestion, setSuggestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  const [waitlisted, setWaitlisted] = useState(false);

  function handleUseKey(e: React.FormEvent) {
    e.preventDefault();
    if (!isLikelyOpenAiKey(key)) {
      setKeyError("That doesn't look like an OpenAI key. It should start with sk-.");
      return;
    }
    // Write into the shared localStorage BYOK store (same one the in-interview
    // API Keys drawer reads/writes), so it's a single source of truth and the
    // key can be changed or cleared from the drawer at any time.
    saveProviderKeys({ ...loadProviderKeys(), openai: key.trim() });
    router.push(`/interview/${questionId}`);
  }

  async function handleWaitlist(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setWaitlistError("That doesn't look like an email address.");
      return;
    }
    setSubmitting(true);
    setWaitlistError(null);
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: trimmed,
          suggestion: suggestion.trim() || undefined,
          questionId,
          source: "waitlist",
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error ?? `Signup failed (${res.status})`);
      }
      setWaitlisted(true);
    } catch (err) {
      setWaitlistError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 px-6 text-zinc-100">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col py-12 sm:py-20">
        <header>
          <Link href="/" className="font-mono text-sm text-zinc-500 hover:text-zinc-300">
            ai-interviewer
          </Link>
        </header>

        <main className="mt-14 flex-1 sm:mt-20">
          <h1 className="max-w-xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            Alex is at capacity right now.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-zinc-400">
            The shared demo is getting more interviews than its budget can cover
            at the moment. You can keep going immediately with your own OpenAI
            key, or leave your email and we&apos;ll tell you the second a slot
            opens up.
          </p>

          <div className="mt-9 space-y-4">
            {/* Use your own key */}
            <form
              onSubmit={handleUseKey}
              className="rounded-lg border border-zinc-700 bg-zinc-900/70 p-5"
            >
              <h2 className="text-sm font-semibold text-zinc-100">
                Continue with your own OpenAI key
              </h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-400">
                Your key is saved in this browser only (never on our servers) and
                sent just with your own interview requests. You can change or
                remove it anytime from the API Keys panel during the interview.
                Get one at{" "}
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-300 underline decoration-emerald-800 underline-offset-4 transition hover:text-emerald-200"
                >
                  platform.openai.com
                </a>
                .
              </p>
              <label className="mt-4 block">
                <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  OpenAI API key
                </span>
                <input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="sk-…"
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-600 focus:outline-none"
                />
              </label>
              {keyError && (
                <p className="mt-2 text-[13px] text-red-400" role="alert">
                  {keyError}
                </p>
              )}
              <button
                type="submit"
                disabled={key.trim().length === 0}
                className="mt-4 w-full rounded-md border border-emerald-600/70 bg-emerald-950/40 px-3 py-2 text-sm font-medium text-emerald-100 transition hover:bg-emerald-900/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Start the interview
              </button>
            </form>

            {/* Waitlist */}
            {waitlisted ? (
              <div className="rounded-lg border border-emerald-800/60 bg-emerald-950/30 p-5">
                <h2 className="text-sm font-semibold text-emerald-300">
                  You&apos;re on the list
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-zinc-300">
                  We&apos;ll email you when a free slot opens up.
                </p>
              </div>
            ) : (
              <form
                onSubmit={(e) => void handleWaitlist(e)}
                className="rounded-lg border border-zinc-700 bg-zinc-900/70 p-5"
              >
                <h2 className="text-sm font-semibold text-zinc-100">
                  Or get notified when a slot opens
                </h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-400">
                  No key, no problem. Leave your email and we&apos;ll reach out.
                  No spam.
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
                    className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-600 focus:outline-none"
                  />
                </label>
                <label className="mt-3 block">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                    Anything you want to tell us?{" "}
                    <span className="normal-case text-zinc-600">(optional)</span>
                  </span>
                  <textarea
                    value={suggestion}
                    onChange={(e) => setSuggestion(e.target.value)}
                    rows={3}
                    maxLength={2000}
                    placeholder="e.g. I'd pay for unlimited interviews"
                    className="mt-1 w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-600 focus:outline-none"
                  />
                </label>
                {waitlistError && (
                  <p className="mt-2 text-[13px] text-red-400" role="alert">
                    {waitlistError}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={submitting || email.trim().length === 0}
                  className="mt-4 w-full rounded-md border border-zinc-600 bg-zinc-900/80 px-3 py-2 text-sm font-medium text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? "Sending" : "Keep me posted"}
                </button>
              </form>
            )}
          </div>

          <p className="mt-6 font-mono text-xs text-zinc-600">
            <Link href="/" className="underline decoration-zinc-700 underline-offset-4 hover:text-zinc-400">
              ← back to home
            </Link>
          </p>
        </main>
      </div>
    </div>
  );
}
