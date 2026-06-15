import { unstable_cache } from "next/cache";
import Link from "next/link";

import { getAllPublicQuestions, getPublicQuestionById } from "@/lib/questions";
import { getSignupCount } from "@/lib/stats";

// The CTA drops the visitor straight into an interview — the 30-second path is
// land → read one screen → Alex says hi. Two Sum is the most battle-tested
// question in the bank (full variant ladder); fall back to whatever exists so
// the button never 404s if the bank changes.
const DEFAULT_QUESTION_ID = "two-sum";

// Social proof doesn't need to be real-time — one Redis read per 5 min, shared
// across all visitors via Next's data cache.
const getCachedSignupCount = unstable_cache(
  () => getSignupCount(),
  ["landing-signup-count"],
  { revalidate: 300 }
);

export default async function Home() {
  const signupCount = await getCachedSignupCount();
  const defaultQuestion =
    getPublicQuestionById(DEFAULT_QUESTION_ID) ?? getAllPublicQuestions()[0];
  const startHref = defaultQuestion
    ? `/interview/${defaultQuestion.id}`
    : "/questions";

  return (
    <div className="min-h-screen bg-zinc-950 px-6 text-zinc-100">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col py-12 sm:py-20">
        <header>
          <p className="font-mono text-sm text-zinc-500">ai-interviewer</p>
        </header>

        <main className="mt-14 flex-1 sm:mt-20">
          <h1 className="max-w-xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            A coding interview that pushes back.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-zinc-400">
            Alex gives you a problem and listens while you think out loud. Your
            code runs against hidden tests you can&apos;t see. Pass too easily
            and the problem gets harder. At the end you get a written scorecard
            built from what you actually did, not generic praise.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-4">
            <Link
              href={startHref}
              className="rounded-md border border-emerald-600/70 bg-emerald-950/40 px-5 py-2.5 text-sm font-medium text-emerald-100 transition hover:bg-emerald-900/50"
            >
              Start an interview
            </Link>
            <Link
              href="/questions"
              className="text-sm text-zinc-400 underline decoration-zinc-700 underline-offset-4 transition hover:text-zinc-200"
            >
              or pick a different problem
            </Link>
          </div>
          <p className="mt-4 font-mono text-xs text-zinc-600">
            free · no account · 30-45 min · mic recommended
          </p>
          {signupCount > 10 && (
            <p className="mt-4 text-sm text-zinc-400">
              Join{" "}
              <span className="font-medium text-zinc-200">
                {signupCount.toLocaleString()}
              </span>{" "}
              people who&apos;ve practiced with Alex.
            </p>
          )}

          <div className="mt-16 border-t border-zinc-800/80 pt-8 sm:mt-20">
            <h2 className="font-mono text-xs uppercase tracking-widest text-zinc-500">
              How a round goes
            </h2>
            <ol className="mt-5 max-w-xl space-y-4 text-sm leading-relaxed text-zinc-300">
              <li className="flex gap-4">
                <span className="font-mono text-zinc-600">1</span>
                <span>
                  Clarify and plan. The editor stays locked until you&apos;ve
                  stated an approach and its complexity, same as a real
                  on-site.
                </span>
              </li>
              <li className="flex gap-4">
                <span className="font-mono text-zinc-600">2</span>
                <span>
                  Code in a real editor. Run the visible examples yourself;
                  Submit grades hidden edge cases. Brute force that passes gets
                  you one question: can you do better?
                </span>
              </li>
              <li className="flex gap-4">
                <span className="font-mono text-zinc-600">3</span>
                <span>
                  Solve it and the problem escalates into a harder variant with
                  new constraints and fresh tests, on the same clock.
                </span>
              </li>
              <li className="flex gap-4">
                <span className="font-mono text-zinc-600">4</span>
                <span>
                  Get a scorecard grounded in the evidence: your transcript, how
                  your code evolved, every test run, your pacing, and whether
                  you went quiet while coding.
                </span>
              </li>
            </ol>
          </div>

          <div className="mt-12 border-t border-zinc-800/80 pt-8">
            <h2 className="font-mono text-xs uppercase tracking-widest text-zinc-500">
              Why not just ChatGPT?
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-zinc-300">
              Chat grades the conversation. This grades the work. It watches
              the editor, executes your code against tests it never shows you,
              and hears the difference between narrating your approach and
              typing in silence. When the feedback says you failed a hidden
              edge case twice, it is because it was there.
            </p>
          </div>
        </main>

        <footer className="mt-16 border-t border-zinc-800/80 pt-6 pb-2">
          <p className="font-mono text-xs text-zinc-600">
            Monaco editor · Judge0 execution · Whisper transcription · not a
            chat wrapper.
          </p>
        </footer>
      </div>
    </div>
  );
}
