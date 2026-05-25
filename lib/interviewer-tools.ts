// Hidden test data is server-only. Tool returns aggregate counts for hidden
// cases — never input, expected, or actual values — per CLAUDE.md.

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { FOLLOW_UP_SAFETY_CAP, TEST_RUNS_MAX } from "./interview-limits";
import { runCode } from "./judge0";
import { getQuestionById } from "./questions";
import {
  assertKnownTool,
  isToolAllowed,
  type SessionState,
  type ToolName,
} from "./session-state";

/** Build the phase-filtered tool set for one agent turn. */
export function buildTools(state: SessionState): ToolSet {
  const allTools = {
    get_session_state: tool({
      description:
        "Get the current session state: phase, editor lock state, remaining round time, follow-up turn count and cap, test pass/fail summary, and topics already probed. Field names match the live state block in the system prompt. Call this when unsure what has been covered.",
      parameters: z.object({}),
      execute: async () => ({
        phase: state.phase,
        editorLocked: state.editorLocked,
        // Computed at call time; drifts a few seconds during generation — expected, not a bug.
        remainingMs:
          state.roundEndsAt !== null
            ? Math.max(0, state.roundEndsAt - Date.now())
            : null,
        followUpTurnsUsed: state.followUpTurnsUsed,
        followUpTurnsMax: FOLLOW_UP_SAFETY_CAP,
        testRunsUsed: state.testRunsUsed,
        testRunsMax: TEST_RUNS_MAX,
        visibleTestsPassed: state.lastTestResult?.visiblePassed ?? null,
        hiddenTestsPassed: state.lastTestResult?.hiddenPassed ?? null,
        topicsProbed: state.topicsProbed,
        lastTestResult: state.lastTestResult
          ? {
              passedCount: state.lastTestResult.passedCount,
              failedCount: state.lastTestResult.failedCount,
              hiddenFailedCount: state.lastTestResult.hiddenFailedCount,
            }
          : null,
      }),
    }),

    read_current_code: tool({
      description:
        "Read the exact current code in the editor. Always call this before commenting on the candidate's implementation.",
      parameters: z.object({}),
      execute: async () => ({
        code: state.currentCode,
        language: "python",
      }),
    }),

    read_recent_transcript: tool({
      description:
        "Read the last N lines of the candidate's voice transcript (ambient mic during coding + focused-mic messages). Use when you need to know what the candidate said verbally but it may not appear in chat.",
      parameters: z.object({
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
        "Get the results of the last Judge0 test run. Visible cases are returned with full input/expected/actual; hidden cases are returned as aggregate counts only — never as inputs or expected outputs.",
      parameters: z.object({}),
      execute: async () => {
        if (state.lastTestResult === null) {
          return { message: "No tests have been run yet." };
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
        };
      },
    }),

    run_tests: tool({
      description:
        "Execute the candidate's current code via Judge0 against visible and hidden test cases. Returns visible cases in detail; hidden cases as aggregate counts only. Subject to a per-session cap (testRunsMax); returns a structured rejection if the cap is reached.",
      parameters: z.object({}),
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
          // rebuild — get_session_state will return stale values within this
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
            note: "Run completed. The app will increment testRunsUsed and commit lastTestResult to session state.",
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

    mark_topic_probed: tool({
      description:
        "Mark a topic as already probed so you do not ask about it again. Call after you have asked about a topic and received a response. The app commits this to SessionState; the returned topicsProbed array is what the agent should treat as current.",
      parameters: z.object({
        topic: z
          .string()
          .min(1)
          .describe(
            'Short label for the topic — e.g. "begin<=end fix", "empty array edge case", "duplicate handling".'
          ),
      }),
      execute: async ({ topic }) => ({
        recorded: topic,
        topicsProbed: Array.from(new Set([...state.topicsProbed, topic])),
      }),
    }),
  };

  // Filter by current phase. assertKnownTool is a defensive runtime check
  // against typos in the keys above; isToolAllowed is the actual phase gate.
  const filtered: Record<string, (typeof allTools)[ToolName]> = {};
  for (const name of Object.keys(allTools) as ToolName[]) {
    assertKnownTool(name);
    if (isToolAllowed(name, state.phase)) {
      filtered[name] = allTools[name];
    }
  }
  return filtered as ToolSet;
}
