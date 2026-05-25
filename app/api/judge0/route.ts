import { runCode, type HiddenTestCase, type TestCase } from "@/lib/judge0";

export const runtime = "nodejs";

const ENTRY_FN_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function isTestCase(x: unknown): x is TestCase {
  if (x === null || typeof x !== "object") {
    return false;
  }
  const o = x as Record<string, unknown>;
  return typeof o.input === "string" && typeof o.expected === "string";
}

function isHiddenTestCase(x: unknown): x is HiddenTestCase {
  if (!isTestCase(x)) return false;
  const o = x as Record<string, unknown>;
  return o.description === undefined || typeof o.description === "string";
}

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
  const { code, testCases, hiddenTestCases, entryFunction } = body as {
    code?: unknown;
    testCases?: unknown;
    hiddenTestCases?: unknown;
    entryFunction?: unknown;
  };
  if (typeof code !== "string") {
    return Response.json({ error: "code must be a string" }, { status: 400 });
  }
  if (!Array.isArray(testCases) || !testCases.every(isTestCase)) {
    return Response.json(
      { error: "testCases must be an array of { input, expected }" },
      { status: 400 }
    );
  }
  const hidden: HiddenTestCase[] =
    Array.isArray(hiddenTestCases) && hiddenTestCases.every(isHiddenTestCase)
      ? (hiddenTestCases as HiddenTestCase[])
      : [];
  const entry =
    typeof entryFunction === "string" && ENTRY_FN_RE.test(entryFunction)
      ? entryFunction
      : null;
  if (entry == null) {
    return Response.json(
      { error: "entryFunction must be a valid Python identifier" },
      { status: 400 }
    );
  }
  try {
    const result = await runCode(code, testCases, entry, hidden);
    return Response.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 502 });
  }
}
