"use client";

import type { TestResult } from "@/lib/judge0";

type Props = {
  results: TestResult[] | null;
  allPassed: boolean | null;
  loading: boolean;
  error: string | null;
};

export function TestResultsPanel({
  results,
  allPassed,
  loading,
  error,
}: Props) {
  return (
    <div className="px-3 py-3">
      {error && (
        <p className="mb-2 text-sm text-rose-400">{error}</p>
      )}
      {loading && (
        <p className="text-sm text-zinc-400">Running tests…</p>
      )}
      {!loading && allPassed === true && results && results.length > 0 && (
        <p className="mb-2 text-sm font-medium text-emerald-400">
          All tests passed.
        </p>
      )}
      {results && results.length > 0 && (
        <ul className="flex flex-col gap-2">
          {results.map((r, i) => (
            <li
              key={`${r.input}-${i}`}
              className={`rounded-md border px-2 py-1.5 text-xs ${
                r.passed
                  ? "border-emerald-800/80 bg-emerald-950/30 text-emerald-100"
                  : "border-rose-900/80 bg-rose-950/25 text-rose-100"
              }`}
            >
              <div className="font-medium">
                Case {i + 1}{" "}
                <span className="opacity-80">
                  {r.passed ? "(pass)" : "(fail)"}
                </span>
              </div>
              <div className="mt-1 text-zinc-300">
                <span className="text-zinc-500">Input:</span> {r.input}
              </div>
              <div className="mt-0.5 text-zinc-300">
                <span className="text-zinc-500">Expected:</span> {r.expected}
              </div>
              <div className="mt-0.5 whitespace-pre-wrap wrap-break-word">
                <span className="text-zinc-500">Actual:</span> {r.actual}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
