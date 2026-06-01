// End-of-session written scorecard. This is the one legitimately
// non-conversational, evidence-heavy job: a single grounded generation over the
// full transcript, code snapshots, test-run history, pace, and coding-voice
// report. It is NOT part of the turn-by-turn interviewer loop — it is served by
// POST /api/feedback and triggered by the app (Continue button / round-clock
// backstop), never by a model tool call.
//
// The evidence assembly here was preserved verbatim from the former
// lib/ai.ts:getFeedback when /api/ai was deleted.

import type { ChatMessage } from "@/lib/chat";
import type { CodingVoiceReport } from "@/lib/coding-voice-report";
import type { AiModelConfig } from "@/lib/ai-models";
import type { ProviderMessage } from "@/lib/providers/types";
import * as geminiProvider from "@/lib/providers/gemini";
import * as groqProvider from "@/lib/providers/groq";
import * as anthropicProvider from "@/lib/providers/anthropic";
import * as openaiProvider from "@/lib/providers/openai";
import {
  type ConcreteInterviewerStyle,
  styleDisplayName,
} from "@/lib/interviewer-presets";

export type InterviewLevel = "intern" | "new-grad" | "mid" | "senior";

export type FeedbackSnapshot = {
  code: string;
  transcript: string;
  timestamp: number;
};

export type PaceReport = {
  /** Minutes from coding start to first fully-passing visible-test run. null if tests never passed. */
  baselineMinutes: number | null;
  /** How many planned follow-up variants were actually introduced by the interviewer during the session. */
  followUpsReached: number;
  /** Total follow-up variants available for this question. */
  followUpsAvailable: number;
  /** True if the round timer expired before all available follow-ups were reached. */
  ranOutOfTime: boolean;
  /**
   * True when the candidate's very first code run already passed every visible + hidden test —
   * no observed brute-force → optimal arc. Often indicates memorized problem or skipped narration.
   */
  bruteForceSkipped: boolean;
  /**
   * Number of in-coding escalations the interviewer introduced
   * (e.g. "now do it in O(1) space"). Each banked follow-up trigger fired
   * during the coding phase counts as one.
   */
  escalationsAttempted: number;
  /**
   * True when the round-clock cutoff fired while the candidate was still coding,
   * forcing a verbal final-approach wrap-up before follow-up could begin.
   */
  forcedWrap: boolean;
};

const FEEDBACK_SYSTEM_PROMPT = `You are Alex. The live conversation is over; you now write the candidate's structured written feedback only. Be honest and specific.

Use these exact section headings (## markdown), each followed by your analysis:

## Correctness
## Approach
## Communication
## What you did well
## What to improve
## Score

- Communication: cover clarifications before coding, how clearly they explained their approach before implementing, post-implementation discussion, and—critically—**oral think-aloud while coding**. The app records **voice only while the code editor is active** (the coding segment). **Typing in chat is not a substitute** for thinking aloud in a real on-site. Weave in naturally—do not add a separate "follow-up questions" list or label chunks of the conversation as "phases".
- **Coding voice report (obligatory when present below):** If the report shows negligibleThinkAloud: true (too few words captured while coding), treat silent coding as a serious communication gap: **comms must be at most 2** and ## Communication and ## What to improve must state explicitly that a real interview expects you to **narrate as you go** (or at least when prompted). If negligibleThinkAloud is false but word count is still low, cap **comms at 3** unless the voice shows clear, sustained explanation while coding. Do not inflate comms from chat quality alone when the voice report is negligible.
- Apply the same complexity conventions as in the live interview (e.g. O(1) auxiliary for brute force with only indices is correct unless they allocated O(n) extra structures).
- Pacing: A real interviewer typically prepares a baseline problem and one or more follow-up variants sized to fit the round. If a paceReport is provided below the candidate data, use it as ground truth for these judgments: reaching follow-ups is a positive signal; running out of time before a follow-up that fit the round is a negative one. Do not speculate about pacing beyond what the report states.
- ## Score section: after all written sections, output exactly one line in this format (nothing else):
  clarify=N algo=N code=N verification=N comms=N
  where each N is a single integer 1–5. Ceilings that must be respected:
    - If the session lacked a follow-up and one was available and expected to fit, cap algo at 3.
    - If paceReport.bruteForceSkipped is true, cap comms at 3 — jumping straight to the optimal hides the tradeoff-recognition narration a real loop expects.
    - If paceReport.forcedWrap is true (round clock forced a verbal wrap-up while still coding), cap **code at 3** unless escalationsAttempted >= 1 and the candidate handled at least one escalation cleanly. Pacing was a real gap.
    - If paceReport.escalationsAttempted >= 1 and the candidate addressed an escalation correctly, that is a positive signal for **algo** — do not cap algo low purely because they didn't reach a separate banked follow-up.
    - If the coding-voice report shows negligibleThinkAloud, cap comms at **2** (hard ceiling). If word count is in the 20–44 range, cap comms at 3 unless voice clearly shows ongoing narration.`;

async function* streamFromProvider(
  modelConfig: AiModelConfig,
  system: string,
  messages: ProviderMessage[],
  apiKey?: string
): AsyncGenerator<string> {
  const opts = { system, messages, model: modelConfig.model, apiKey };
  switch (modelConfig.provider) {
    case "groq":
      yield* groqProvider.streamChat(opts);
      break;
    case "gemini":
      yield* geminiProvider.streamChat(opts);
      break;
    case "anthropic":
      yield* anthropicProvider.streamChat(opts);
      break;
    case "openai":
      yield* openaiProvider.streamChat(opts);
      break;
    default: {
      const _exhaustive: never = modelConfig.provider;
      throw new Error(`Unknown provider: ${String(_exhaustive)}`);
    }
  }
}

function formatChatHistoryForFeedback(messages: ChatMessage[]): string {
  return messages
    .map((m) =>
      m.role === "user"
        ? `Candidate: ${m.content}`
        : `Interviewer: ${m.content}`
    )
    .join("\n\n");
}

function formatSnapshots(snapshots: FeedbackSnapshot[]): string {
  if (snapshots.length === 0) {
    return "(No periodic snapshots were recorded.)";
  }
  return snapshots
    .map(
      (s, i) =>
        `--- Snapshot ${i + 1} at ${new Date(s.timestamp).toISOString()} ---\nCode:\n\`\`\`python\n${s.code}\n\`\`\`\nTranscript note: ${s.transcript || "(none)"}`
    )
    .join("\n\n");
}

function formatCodingVoiceReport(r: CodingVoiceReport | null): string {
  if (r === null) {
    return "\n\nCoding-segment voice report: not available (treat as unknown; do not assume silence).";
  }
  return `\n\nCoding-segment voice report (ground truth: ambient capture while the editor is active; clarifying/planning are not included):\n- Utterance count: ${r.utteranceCount}\n- Word count (approx.): ${r.wordCount}\n- negligibleThinkAloud: ${r.negligibleThinkAloud} (if true, apply the hard comms cap per system instructions; if 20–44 words, apply the softer comms cap unless narration was clearly continuous).`;
}

function formatPaceReport(r: PaceReport): string {
  const lines: string[] = [
    "",
    "",
    "Pace report (use as ground truth; do not speculate beyond it):",
    `- Baseline minutes to first all-pass: ${r.baselineMinutes != null ? `${r.baselineMinutes.toFixed(1)} min` : "N/A (tests never fully passed)"}`,
    `- Follow-ups reached / available: ${r.followUpsReached} / ${r.followUpsAvailable}`,
    `- In-coding escalations introduced: ${r.escalationsAttempted}`,
    `- Round timed out before all follow-ups: ${r.ranOutOfTime ? "yes" : "no"}`,
    `- Forced verbal wrap-up (round-clock cutoff fired during coding): ${r.forcedWrap ? "yes" : "no"}`,
    `- Brute-force skipped (first run already passed everything): ${r.bruteForceSkipped ? "yes" : "no"}`,
  ];
  return lines.join("\n");
}

/**
 * End-of-session structured feedback (streams markdown-style sections). The one
 * grounded, evidence-heavy generation — must cite real evidence (timing, hidden
 * fails, think-aloud), never generic praise.
 */
export async function* streamFeedback(
  modelConfig: AiModelConfig,
  question: string,
  fullTranscript: string,
  snapshots: FeedbackSnapshot[],
  finalCode: string,
  chatHistory: ChatMessage[],
  traceContent: string | null = null,
  interviewerStyle: ConcreteInterviewerStyle | null = null,
  paceReport: PaceReport | null = null,
  level: InterviewLevel | null = null,
  codingVoiceReport: CodingVoiceReport | null = null,
  apiKey?: string
): AsyncGenerator<string> {
  const transcriptSection =
    fullTranscript.trim().length > 0
      ? fullTranscript
      : "(No voice transcript was recorded for this session.)";

  const traceSection =
    traceContent && traceContent.trim().length > 0
      ? `\n\nCandidate's dry-run trace (they stepped through the algorithm manually without executing code):\n${traceContent}`
      : "";

  const userPrompt = `Full problem statement:
${question}

Note: The transcript includes their post-implementation Q&A with you. Use it in your write-up; do not add a fresh numbered list of "follow-up questions" for them to answer.

Full voice transcript (with timestamps if provided):
${transcriptSection}

Periodic code snapshots:
${formatSnapshots(snapshots)}

Final code:
\`\`\`python
${finalCode}
\`\`\`

Full chat history:
${formatChatHistoryForFeedback(chatHistory)}${traceSection}${paceReport != null ? formatPaceReport(paceReport) : ""}${formatCodingVoiceReport(codingVoiceReport)}`;

  const levelCalibration = level
    ? `\n\nLevel calibration: the candidate was practicing at the "${level}" bar. Calibrate your scores and written assessment accordingly.`
    : "";

  const styleCalibration = interviewerStyle
    ? `\n\nInterviewer style active in this session: ${styleDisplayName(interviewerStyle)}. Let this calibrate your feedback tone and emphasis. Close the "What to improve" section (before the Score section) with one sentence: "Your interviewer today was calibrated toward ${styleDisplayName(interviewerStyle)}."`
    : "";

  yield* streamFromProvider(
    modelConfig,
    FEEDBACK_SYSTEM_PROMPT + levelCalibration + styleCalibration,
    [{ role: "user", content: userPrompt }],
    apiKey
  );
}
