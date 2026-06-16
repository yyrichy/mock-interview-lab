import Link from "next/link";

import QuestionBrowser from "@/components/QuestionBrowser";
import {
  compareQuestions,
  getAllCompanies,
  getAllDifficulties,
  getAllLabels,
  getAllPublicQuestions,
} from "@/lib/questions";

export default function QuestionsPage() {
  // Browser-safe questions only — interviewerContext and hiddenTestCases never
  // cross into the client QuestionBrowser.
  const questions = getAllPublicQuestions().sort(compareQuestions);
  const allLabels = getAllLabels();
  const allCompanies = getAllCompanies();
  const allDifficulties = getAllDifficulties();

  return (
    <div className="min-h-screen bg-zinc-950 px-6 py-10 text-zinc-100">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8">
          <Link
            href="/"
            className="font-mono text-xs text-zinc-500 transition hover:text-zinc-300"
          >
            ← Mock Coding
          </Link>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">
            Pick a problem
          </h1>
          <p className="mt-2 text-sm text-zinc-500">
            Each one starts a full mock interview: live editor, voice, hidden
            tests, follow-ups, and a written scorecard.
          </p>
        </header>

        <QuestionBrowser
          questions={questions}
          allLabels={allLabels}
          allCompanies={allCompanies}
          allDifficulties={allDifficulties}
        />
      </div>
    </div>
  );
}
