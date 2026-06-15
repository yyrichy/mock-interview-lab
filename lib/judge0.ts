/**
 * Judge0 code execution. Call from a server context (e.g. Next.js route handler)
 * so requests are not blocked by browser CORS.
 */

export type TestCase = { input: string; expected: string };

export type HiddenTestCase = TestCase & { description?: string };

export type TestResult = {
  input: string;
  expected: string;
  actual: string;
  passed: boolean;
};

export type RunCodeResult = {
  passed: boolean;
  results: TestResult[];
  hiddenPassed: boolean;
  hiddenResults: TestResult[];
};

type Judge0Status = {
  id: number;
  description?: string;
};

type Judge0Submission = {
  stdout: string | null;
  stderr: string | null;
  compile_output: string | null;
  message: string | null;
  status: Judge0Status;
};

const PYTHON_LANG_ID = 71;

/** Public CE instance (works without API key). Override with JUDGE0_API_URL. */
function judge0BaseUrl(): string {
  return (
    process.env.JUDGE0_API_URL?.replace(/\/$/, "") ?? "https://ce.judge0.com"
  );
}

/**
 * Optional auth header for paid/hosted or self-hosted Judge0. Generic
 * name/value pair because providers disagree on the header (Sulu uses
 * Authorization, RapidAPI uses X-RapidAPI-Key, self-hosted uses X-Auth-Token).
 * With the env vars unset, no header is sent — identical to the public
 * CE-instance behavior. The value is server-only and never logged.
 */
function judge0AuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const name = process.env.JUDGE0_AUTH_HEADER_NAME;
  const value = process.env.JUDGE0_AUTH_HEADER_VALUE;
  if (name && value) {
    headers[name] = value;
  }
  // RapidAPI's gateway also requires X-RapidAPI-Host alongside X-RapidAPI-Key to
  // route the request; without it the gateway returns 403 "not subscribed".
  // Self-hosted/Sulu users leave this unset and are unaffected.
  const rapidApiHost = process.env.JUDGE0_RAPIDAPI_HOST;
  if (rapidApiHost) {
    headers["X-RapidAPI-Host"] = rapidApiHost;
  }
  return headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isProcessingStatus(id: number): boolean {
  return id === 1 || id === 2;
}

/**
 * Retry a fetch-style operation with exponential backoff on transient failures.
 * Retries when the operation throws (network errors) or when shouldRetry(result)
 * returns true (e.g. HTTP 429/5xx). Final attempt's failure is surfaced unchanged.
 */
async function withRetry<T>(
  op: () => Promise<T>,
  shouldRetry: (result: T) => boolean = () => false,
  attempts = 3,
  baseDelayMs = 800
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await op();
      if (i < attempts - 1 && shouldRetry(result)) {
        await sleep(baseDelayMs * Math.pow(2, i));
        continue;
      }
      return result;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await sleep(baseDelayMs * Math.pow(2, i));
        continue;
      }
    }
  }
  throw lastErr ?? new Error("Judge0 request failed after retries");
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * `input` is a JSON array of positional arguments, e.g. `[[2,7,11,15],9]` for two_sum.
 */
function parseTestArgs(input: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.trim());
  } catch {
    throw new Error(`Invalid test input (not valid JSON): ${input}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Invalid test input (must be a JSON array of arguments): ${input}`
    );
  }
  return parsed;
}

function buildHarnessedSource(
  userCode: string,
  testInput: string,
  entryFunction: string
): string {
  const args = parseTestArgs(testInput);
  const argsLiteral = JSON.stringify(JSON.stringify(args));
  return `import json

${userCode}

if __name__ == "__main__":
    _args = json.loads(${argsLiteral})
    result = ${entryFunction}(*_args)
    print(json.dumps(result, separators=(",", ":")))
`;
}

function normalizeCompare(s: string): string {
  return s.trim().replace(/\s+/g, "");
}

function outputsMatch(actual: string, expected: string): boolean {
  const a = actual.trim();
  const e = expected.trim();
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(e));
  } catch {
    return normalizeCompare(a) === normalizeCompare(e);
  }
}

function describeFailure(sub: Judge0Submission): string {
  const statusId = sub.status?.id;
  const desc = sub.status?.description ?? `status ${statusId}`;
  const compile = sub.compile_output?.trim();
  const stderr = sub.stderr?.trim();
  const msg = sub.message?.trim();
  const parts = [desc];
  if (compile) {
    parts.push(`Compile:\n${compile}`);
  }
  if (stderr) {
    parts.push(`Runtime:\n${stderr}`);
  }
  if (msg) {
    parts.push(msg);
  }
  return parts.filter(Boolean).join("\n\n");
}

/** Map a finished Judge0 submission back to a TestResult for its test case. */
function toTestResult(tc: TestCase, sub: Judge0Submission): TestResult {
  if (sub.status?.id === 3 && sub.stdout != null) {
    const actual = sub.stdout.trim();
    return {
      input: tc.input,
      expected: tc.expected,
      actual,
      passed: outputsMatch(actual, tc.expected),
    };
  }
  return {
    input: tc.input,
    expected: tc.expected,
    actual: describeFailure(sub),
    passed: false,
  };
}

async function createSubmission(sourceCode: string): Promise<string> {
  const base = judge0BaseUrl();
  const res = await withRetry(
    () =>
      fetch(`${base}/submissions?base64_encoded=false&wait=false`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...judge0AuthHeaders() },
        body: JSON.stringify({
          source_code: sourceCode,
          language_id: PYTHON_LANG_ID,
        }),
      }),
    (r) => isTransientStatus(r.status)
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Judge0 create failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { token?: string };
  if (typeof data.token !== "string") {
    throw new Error("Judge0 did not return a submission token");
  }
  return data.token;
}

async function getSubmission(token: string): Promise<Judge0Submission> {
  const base = judge0BaseUrl();
  const res = await withRetry(
    () =>
      fetch(
        `${base}/submissions/${encodeURIComponent(token)}?base64_encoded=false&fields=stdout,stderr,compile_output,message,status`,
        { method: "GET", headers: judge0AuthHeaders() }
      ),
    (r) => isTransientStatus(r.status)
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Judge0 poll failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as Judge0Submission;
}

async function waitForSubmission(token: string): Promise<Judge0Submission> {
  const maxAttempts = 45;
  for (let i = 0; i < maxAttempts; i++) {
    const sub = await getSubmission(token);
    const sid = sub.status?.id;
    if (sid === undefined) {
      throw new Error("Judge0 response missing status");
    }
    if (!isProcessingStatus(sid)) {
      return sub;
    }
    await sleep(350);
  }
  throw new Error("Judge0 execution timed out");
}

/**
 * Create all submissions in one batch POST. Returns tokens in the same order as
 * the input sources (Judge0 preserves order). Throws if the instance rejects the
 * batch endpoint, so the caller can fall back to one-at-a-time submissions.
 */
async function createSubmissionBatch(sourceCodes: string[]): Promise<string[]> {
  const base = judge0BaseUrl();
  const res = await withRetry(
    () =>
      fetch(`${base}/submissions/batch?base64_encoded=false`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...judge0AuthHeaders() },
        body: JSON.stringify({
          submissions: sourceCodes.map((source_code) => ({
            source_code,
            language_id: PYTHON_LANG_ID,
          })),
        }),
      }),
    (r) => isTransientStatus(r.status)
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Judge0 batch create failed (${res.status}): ${text.slice(0, 200)}`
    );
  }
  const data = (await res.json()) as Array<{ token?: string }>;
  if (!Array.isArray(data) || data.length !== sourceCodes.length) {
    throw new Error("Judge0 batch create returned an unexpected token list");
  }
  const tokens = data.map((d) => d.token);
  if (tokens.some((t) => typeof t !== "string")) {
    throw new Error("Judge0 batch create returned a submission without a token");
  }
  return tokens as string[];
}

async function getSubmissionBatch(
  tokens: string[]
): Promise<Judge0Submission[]> {
  const base = judge0BaseUrl();
  const joined = tokens.map((t) => encodeURIComponent(t)).join(",");
  const res = await withRetry(
    () =>
      fetch(
        `${base}/submissions/batch?tokens=${joined}&base64_encoded=false&fields=stdout,stderr,compile_output,message,status`,
        { method: "GET", headers: judge0AuthHeaders() }
      ),
    (r) => isTransientStatus(r.status)
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Judge0 batch poll failed (${res.status}): ${text.slice(0, 200)}`
    );
  }
  const data = (await res.json()) as { submissions?: Judge0Submission[] };
  if (
    !Array.isArray(data.submissions) ||
    data.submissions.length !== tokens.length
  ) {
    throw new Error("Judge0 batch poll returned an unexpected submission list");
  }
  return data.submissions;
}

async function waitForSubmissionBatch(
  tokens: string[]
): Promise<Judge0Submission[]> {
  const maxAttempts = 45;
  for (let i = 0; i < maxAttempts; i++) {
    const subs = await getSubmissionBatch(tokens);
    const allDone = subs.every((sub) => {
      const sid = sub.status?.id;
      return sid !== undefined && !isProcessingStatus(sid);
    });
    if (allDone) {
      return subs;
    }
    await sleep(350);
  }
  throw new Error("Judge0 batch execution timed out");
}

async function runTestCasesSequential(
  code: string,
  testCases: TestCase[],
  entryFunction: string
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const tc of testCases) {
    const source = buildHarnessedSource(code, tc.input, entryFunction);
    const token = await createSubmission(source);
    const sub = await waitForSubmission(token);
    results.push(toTestResult(tc, sub));
  }
  return results;
}

/**
 * Run all test cases as a single Judge0 batch (one POST + shared polling) rather
 * than one submission per case — fewer round-trips and faster. Falls back to
 * sequential submissions if the instance does not support the batch endpoint, so
 * the result is identical everywhere.
 */
async function runTestCases(
  code: string,
  testCases: TestCase[],
  entryFunction: string
): Promise<TestResult[]> {
  if (testCases.length === 0) {
    return [];
  }
  const sources = testCases.map((tc) =>
    buildHarnessedSource(code, tc.input, entryFunction)
  );
  try {
    const tokens = await createSubmissionBatch(sources);
    const subs = await waitForSubmissionBatch(tokens);
    return testCases.map((tc, i) => toTestResult(tc, subs[i]));
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "Judge0 batch submission failed; falling back to sequential.",
        err
      );
    }
    return runTestCasesSequential(code, testCases, entryFunction);
  }
}

/**
 * Run `code` against Judge0. `entryFunction` is the Python callable name (e.g. `two_sum`).
 * Each test `input` must be a JSON array of arguments passed positionally.
 * Hidden test results are returned separately and should not be shown in the UI.
 */
export async function runCode(
  code: string,
  testCases: TestCase[],
  entryFunction: string,
  hiddenTestCases: HiddenTestCase[] = []
): Promise<RunCodeResult> {
  const [results, hiddenResults] = await Promise.all([
    runTestCases(code, testCases, entryFunction),
    hiddenTestCases.length > 0
      ? runTestCases(code, hiddenTestCases, entryFunction)
      : Promise.resolve([] as TestResult[]),
  ]);

  return {
    passed: results.length > 0 && results.every((r) => r.passed),
    results,
    hiddenPassed: hiddenResults.length === 0 || hiddenResults.every((r) => r.passed),
    hiddenResults,
  };
}
