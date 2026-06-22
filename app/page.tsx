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
        <header className="flex items-center justify-between gap-3">
          <p className="font-mono text-sm text-zinc-500">Mock Coding</p>
          <a
            href="https://github.com/karanjot-gaidu/ai-mock-interviewer"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-xs text-zinc-500 transition hover:text-zinc-200"
          >
            <svg
              viewBox="0 0 16 16"
              className="h-4 w-4"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            GitHub
          </a>
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
