import { notFound } from "next/navigation";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { InterviewWorkspace } from "@/components/InterviewWorkspace";
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

  return (
    <ErrorBoundary>
      <InterviewWorkspace question={question} />
    </ErrorBoundary>
  );
}
