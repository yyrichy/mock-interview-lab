import QuestionBrowser from "@/components/QuestionBrowser";
import {
  compareQuestions,
  getAllCompanies,
  getAllDifficulties,
  getAllLabels,
  getAllQuestions,
} from "@/lib/questions";

export default function Home() {
  const questions = getAllQuestions().sort(compareQuestions);
  const allLabels = getAllLabels();
  const allCompanies = getAllCompanies();
  const allDifficulties = getAllDifficulties();

  return (
    <div className="min-h-screen bg-zinc-950 px-6 py-10 text-zinc-100">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">ai-interviewer</h1>
          <p className="mt-2 text-sm text-zinc-500">
            Pick a problem to start a FAANG-style mock interview with a live editor,
            voice, tests, and structured feedback.
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
