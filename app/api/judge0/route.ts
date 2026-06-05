import { runCode } from "@/lib/judge0";
import { getQuestionById } from "@/lib/questions";

export const runtime = "nodejs";

const ENTRY_FN_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body === null || typeof body !== "object") {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  // The client sends only an identity + the code to run. Test cases (visible AND
  // hidden) are loaded server-side from the question bank by questionId, so
  // hidden inputs/expected never cross the browser boundary. `includeHidden`
  // distinguishes a Submit (grades hidden cases) from a Run (visible only).
  const { questionId, code, includeHidden } = body as {
    questionId?: unknown;
    code?: unknown;
    includeHidden?: unknown;
  };
  if (typeof code !== "string") {
    return Response.json({ error: "code must be a string" }, { status: 400 });
  }
  if (typeof questionId !== "string") {
    return Response.json(
      { error: "questionId must be a string" },
      { status: 400 }
    );
  }
  const question = getQuestionById(questionId);
  if (!question) {
    return Response.json(
      { error: `Unknown questionId "${questionId}"` },
      { status: 400 }
    );
  }
  const entry = ENTRY_FN_RE.test(question.entryFunction)
    ? question.entryFunction
    : null;
  if (entry == null) {
    return Response.json(
      { error: "entryFunction must be a valid Python identifier" },
      { status: 400 }
    );
  }
  // Run = visible only; Submit = visible + hidden grading.
  const hidden = includeHidden === true ? question.hiddenTestCases ?? [] : [];
  try {
    const result = await runCode(code, question.testCases, entry, hidden);
    // Failed hidden cases are surfaced to the model BY DESCRIPTION ONLY (their
    // human-readable label) so it can probe the specific edge case. Raw hidden
    // input/expected/actual are never included. Index alignment holds because
    // runCode executes `hidden` in order into `result.hiddenResults`.
    const failedHiddenDescriptions = hidden
      .filter((_, i) => i < result.hiddenResults.length && !result.hiddenResults[i].passed)
      .map((tc) => tc.description)
      .filter((d): d is string => typeof d === "string");
    // Whitelist response fields — hiddenResults (raw hidden input/expected/actual)
    // is intentionally omitted; it must never reach the browser.
    const hiddenPassedCount = result.hiddenResults.filter((r) => r.passed).length;
    const hiddenFailedCount = result.hiddenResults.filter((r) => !r.passed).length;
    return Response.json({
      passed: result.passed,
      results: result.results,
      hiddenPassed: result.hiddenPassed,
      hiddenPassedCount,
      hiddenFailedCount,
      failedHiddenDescriptions,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 502 });
  }
}
