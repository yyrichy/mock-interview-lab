import { notFound } from "next/navigation";

import { ByokGate } from "@/components/ByokGate";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { InterviewWorkspace } from "@/components/InterviewWorkspace";
import { getByokMode } from "@/lib/byok-mode";
import { getPublicQuestionById } from "@/lib/questions";

type PageProps = {
  params: Promise<{ questionId: string }>;
};

export default async function InterviewPage({ params }: PageProps) {
  const { questionId } = await params;
  // Only the browser-safe shape is handed to the client workspace. The full
  // Question (interviewerContext, hiddenTestCases) is loaded server-side in the
  // /api/interviewer and /api/judge0 routes by questionId.
  const question = getPublicQuestionById(questionId);

  if (!question) {
    notFound();
  }

  // When the demo is at capacity, the gate redirects a keyless visitor to
  // /at-capacity before the workspace mounts. Off (the default) → passthrough.
  const byokModeActive = await getByokMode();

  return (
    <ErrorBoundary>
      <ByokGate byokModeActive={byokModeActive} questionId={question.id}>
        <InterviewWorkspace question={question} />
      </ByokGate>
    </ErrorBoundary>
  );
}
