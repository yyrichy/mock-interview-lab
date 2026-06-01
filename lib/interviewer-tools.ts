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
  type SessionPhase,
  type SessionState,
  type ToolName,
} from "./session-state";

/** Build the phase-filtered tool set for one agent turn. */
export function buildTools(state: SessionState): ToolSet {
  // Closure-scoped: resets every turn because buildTools is called once per
  // turn. Prevents the model from looping set_phase calls within a single
  // multi-step agent run (maxSteps).
  let setPhaseAcceptedThisTurn = false;
  const topicsProbedThisTurn = new Set(state.topicsProbed);

  const allTools = {
    get_session_state: tool({
      description:
        "Get the current session state: phase, editor lock state, remaining round time, follow-up turn count and cap, test pass/fail summary, and topics already probed. Field names match the live state block in the system prompt. Call this when unsure what has been covered.",
      inputSchema: z.object({}),
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

    mark_topic_probed: tool({
      description:
        "Mark one topic as already probed so you do not ask about it again. Call at most once per reply, only after you have asked about a topic and received a response. The app commits this to SessionState; the returned topicsProbed array is what the agent should treat as current. After calling, stop calling tools and respond naturally.",
      inputSchema: z.object({
        topic: z
          .string()
          .min(1)
          .describe(
            'Short label for the topic — e.g. "begin<=end fix", "empty array edge case", "duplicate handling".'
          ),
      }),
      execute: async ({ topic }) => {
        topicsProbedThisTurn.add(topic);
        return {
          recorded: topic,
          topicsProbed: Array.from(topicsProbedThisTurn),
          note: "Topic recorded. Stop calling tools and respond to the candidate now.",
        };
      },
    }),

    set_phase: tool({
      description:
        "Request a phase transition. The app validates and commits the move — the agent cannot force an invalid transition. Valid moves: clarifying→planning, planning→coding, coding→followUp. The end-of-interview transition is owned by generate_final_feedback — do not use this tool for that. Call only when the candidate has clearly completed the current phase.",
      inputSchema: z.object({
        phase: z
          .enum(["planning", "coding", "followUp"])
          .describe("The phase to transition into."),
        reason: z
          .string()
          .min(1)
          .describe("One sentence explaining why the transition is appropriate now."),
      }),
      execute: async ({ phase, reason }) => {
        if (setPhaseAcceptedThisTurn) {
          return {
            accepted: true,
            requestedPhase: phase,
            reason,
            note: "set_phase has already been accepted this turn. Stop calling tools now and respond to the candidate with one short transition sentence (e.g. 'Great — talk me through your approach.'). Do NOT call set_phase again this turn.",
          };
        }
        const VALID_TRANSITIONS: Partial<Record<SessionPhase, SessionPhase>> = {
          clarifying: "planning",
          planning: "coding",
          coding: "followUp",
        };
        const expected = VALID_TRANSITIONS[state.phase];
        if (expected === undefined) {
          return {
            accepted: false,
            reason: `No transition defined from phase "${state.phase}".`,
            currentPhase: state.phase,
          };
        }
        if (phase !== expected) {
          return {
            accepted: false,
            reason: `Invalid transition: "${state.phase}" → "${phase}". Only "${state.phase}" → "${expected}" is allowed.`,
            currentPhase: state.phase,
          };
        }
        setPhaseAcceptedThisTurn = true;
        const responseInstruction =
          expected === "planning"
            ? "Now respond to the candidate with one short sentence asking them to talk through their approach."
            : expected === "coding"
              ? "Now respond to the candidate with one short sentence telling them to implement their plan. Do not ask another approach question."
              : "Now respond to the candidate with one short transition sentence into follow-up discussion.";
        return {
          accepted: true,
          requestedPhase: phase,
          reason,
          note: `Transition request recorded. The app will commit the phase change before the next turn. ${responseInstruction} STOP calling tools.`,
        };
      },
    }),

    start_follow_up_variant: tool({
      description:
        "Signal that you are beginning a new follow-up question variant. Call once per new top-level follow-up topic, BEFORE asking the question. Only call this once when genuinely starting a NEW topic area. Do not call it for follow-on questions within the same topic. Most turns should not call this tool at all. Do NOT call for probing sub-questions inside an existing variant — only for fresh top-level follow-ups. Increments the follow-up turn counter; returns a structured rejection if the cap is reached.",
      inputSchema: z.object({
        variantSummary: z
          .string()
          .min(1)
          .describe(
            "One sentence describing what this follow-up will probe, e.g. 'Asking about time complexity of the optimized solution'."
          ),
      }),
      execute: async ({ variantSummary }) => {
        // state.followUpTurnsUsed is the turn-start snapshot — within a single
        // turn the cap can be exceeded by up to maxSteps - 1 if the model
        // calls this tool repeatedly (worse than run_tests, which is typically
        // 1-over). Accepted tradeoff vs. plumbing live counter mutation
        // through tools.
        if (state.followUpTurnsUsed >= FOLLOW_UP_SAFETY_CAP) {
          return {
            accepted: false,
            reason: "follow_up_cap_reached",
            followUpTurnsUsed: state.followUpTurnsUsed,
            followUpTurnsMax: FOLLOW_UP_SAFETY_CAP,
            message: `Follow-up cap reached (${state.followUpTurnsUsed}/${FOLLOW_UP_SAFETY_CAP}). No further variants available. Wrap up this follow-up phase. Call generate_final_feedback with reason: 'follow_up_complete' to trigger structured feedback.`,
          };
        }
        return {
          accepted: true,
          variantSummary,
          followUpTurnsUsed: state.followUpTurnsUsed + 1,
          followUpTurnsMax: FOLLOW_UP_SAFETY_CAP,
          note: "Variant recorded. The app will increment followUpTurnsUsed before the next turn. Now ask exactly one focused follow-up question and stop calling tools.",
        };
      },
    }),

    generate_final_feedback: tool({
      description:
        "Signal that the interview is complete and final feedback should be generated. Call this when the follow-up phase is finished or when time has expired. The app handles the feedback stream — do NOT attempt to write structured feedback inline. After calling, say a brief natural closing line to the candidate, then stop.",
      inputSchema: z.object({
        reason: z
          .enum(["follow_up_complete", "time_expired", "candidate_requested"])
          .describe("Why feedback is being triggered now."),
      }),
      execute: async ({ reason }) => ({
        accepted: true,
        reason,
        note: "Feedback generation triggered. The app will handle the feedback stream. Say a brief closing line to the candidate (e.g. 'Thanks for working through that with me. Let me put my notes together.') then stop. Do not write feedback content yourself.",
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
