// Grounding/execution tools only. Hidden test data is server-only: tool returns
// aggregate counts for hidden cases — never input, expected, or actual values —
// per CLAUDE.md. Tools are NOT phase-gated and never mutate conversational flow;
// the model uses them only to read evidence and run code.

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { TEST_RUNS_MAX } from "./interview-limits";
import { runCode } from "./judge0";
import { getQuestionById } from "./questions";
import type { SessionState } from "./session-state";

/** Build the grounding tool set for one agent turn. Same four tools every turn. */
export function buildTools(state: SessionState): ToolSet {
  return {
    read_current_code: tool({
      description:
        "Read the exact current code in the editor. Always call this before commenting on the candidate's implementation. This is silent — never tell the candidate you are reading or checking their code; speak as if you already see it.",
      inputSchema: z.object({}),
      execute: async () => ({
        code: state.currentCode,
        language: "python",
      }),
    }),

    read_recent_transcript: tool({
      description:
        "Read the last N lines of the candidate's voice transcript (ambient mic during coding + focused-mic messages). Use when you need to know what the candidate said verbally but it may not appear in chat.",
      inputSchema: z.object({
        lines: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Number of recent transcript lines to return. Default 20, max 100."),
      }),
      execute: async ({ lines = 20 }) => {
        const recent = state.transcript.slice(-lines);
        return {
          count: recent.length,
          transcript: recent
            .map((e) => `[${new Date(e.timestamp).toISOString()}] ${e.text}`)
            .join("\n"),
        };
      },
    }),

    get_test_results: tool({
      description:
        "Get the results of the last Judge0 test run. Visible cases are returned with full input/expected/actual; hidden cases are returned as aggregate counts only — never as inputs or expected outputs. Do not mention this tool by name to the candidate.",
      inputSchema: z.object({}),
      execute: async () => {
        if (state.lastTestResult === null) {
          return {
            message: "No tests have been run yet.",
            note: "Do not tell the candidate you checked for results. Respond naturally — e.g. ask them to walk you through a case — in this same turn.",
          };
        }
        const r = state.lastTestResult;
        const visibleCases = r.cases
          .filter((c) => !c.hidden)
          .map((c) => ({
            input: c.input,
            expected: c.expected,
            actual: c.actual,
            passed: c.passed,
          }));
        return {
          visiblePassed: r.visiblePassed,
          hiddenPassed: r.hiddenPassed,
          passedCount: r.passedCount,
          failedCount: r.failedCount,
          hiddenFailedCount: r.hiddenFailedCount,
          visibleCases,
          note: "Use these results now to respond to the candidate in exactly one message. Never say you fetched or checked results; speak as if you already know the outcome.",
        };
      },
    }),

    run_tests: tool({
      description:
        "Execute the candidate's current code via Judge0 against visible and hidden test cases. Returns visible cases in detail; hidden cases as aggregate counts only. Subject to a per-session cap (testRunsMax); returns a structured rejection if the cap is reached.",
      inputSchema: z.object({}),
      execute: async () => {
        // state.testRunsUsed is from the turn-start snapshot — cap can be
        // exceeded by 1 if run_tests is called twice within the same turn.
        // Accepted tradeoff vs. plumbing live counter mutation through tools.
        if (state.testRunsUsed >= TEST_RUNS_MAX) {
          return {
            rejected: true,
            reason: "test_run_cap_reached",
            testRunsUsed: state.testRunsUsed,
            testRunsMax: TEST_RUNS_MAX,
            message: `Test run cap reached (${state.testRunsUsed}/${TEST_RUNS_MAX}). No further runs available this session.`,
          };
        }
        // SessionState.question is a Pick that excludes hiddenTestCases by
        // design. Look up the full Question server-side to access hidden cases
        // without exposing them on the model-facing state shape.
        const fullQuestion = getQuestionById(state.question.id);
        if (!fullQuestion) {
          return {
            rejected: true,
            reason: "question_not_found",
            message: `Could not look up question "${state.question.id}" in the question bank.`,
          };
        }
        try {
          const result = await runCode(
            state.currentCode,
            fullQuestion.testCases,
            fullQuestion.entryFunction,
            fullQuestion.hiddenTestCases ?? []
          );
          const visibleCases = result.results.map((r) => ({
            input: r.input,
            expected: r.expected,
            actual: r.actual,
            passed: r.passed,
          }));
          // App must commit testRunsUsed and lastTestResult on next turn
          // rebuild — get_test_results will return stale values within this
          // same turn (still reflects turn-start snapshot).
          return {
            rejected: false,
            visiblePassed: result.passed,
            hiddenPassed: result.hiddenPassed,
            passedCount: result.results.filter((r) => r.passed).length,
            failedCount: result.results.filter((r) => !r.passed).length,
            hiddenFailedCount: result.hiddenResults.filter((r) => !r.passed)
              .length,
            visibleCases,
            note: "Run completed silently. Respond to the candidate now in exactly one message, using these results as if you already knew the outcome. Do not say you ran, will run, or checked tests — the candidate must not learn this was a discrete action.",
          };
        } catch (e) {
          return {
            rejected: true,
            reason: "judge0_error",
            message: e instanceof Error ? e.message : String(e),
          };
        }
      },
    }),
  };
}
