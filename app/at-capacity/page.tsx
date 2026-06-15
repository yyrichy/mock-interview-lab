import { AtCapacity } from "@/components/AtCapacity";
import { getAllPublicQuestions, getPublicQuestionById } from "@/lib/questions";

// The BYOK gate redirects here with ?questionId=<the interview they wanted>.
// Validate it against the bank server-side so the "start" link can never point
// at a bogus id; fall back to the most battle-tested question.
const DEFAULT_QUESTION_ID = "two-sum";

export default async function AtCapacityPage({
  searchParams,
}: {
  searchParams: Promise<{ questionId?: string }>;
}) {
  const { questionId } = await searchParams;
  const requested = questionId ? getPublicQuestionById(questionId) : null;
  const resolved =
    requested ??
    getPublicQuestionById(DEFAULT_QUESTION_ID) ??
    getAllPublicQuestions()[0];

  return <AtCapacity questionId={resolved?.id ?? DEFAULT_QUESTION_ID} />;
}
