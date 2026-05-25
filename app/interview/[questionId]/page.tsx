import { notFound } from "next/navigation";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { InterviewWorkspace } from "@/components/InterviewWorkspace";
import { getQuestionById } from "@/lib/questions";

type PageProps = {
  params: Promise<{ questionId: string }>;
};

export default async function InterviewPage({ params }: PageProps) {
  const { questionId } = await params;
  const question = getQuestionById(questionId);

  if (!question) {
    notFound();
  }

  return (
    <ErrorBoundary>
      <InterviewWorkspace question={question} />
    </ErrorBoundary>
  );
}
