import type { TranscriptEntry } from "@/lib/chat";

/**
 * Mic capture during the coding segment only (ambient Web Speech in InterviewWorkspace).
 * Used to calibrate feedback: silent coding should not receive a strong "comms" score.
 */
export type CodingVoiceReport = {
  utteranceCount: number;
  wordCount: number;
  /**
   * True when there was not enough think-aloud to treat oral communication as passing.
   * Triggers a hard cap on the communication score in written feedback.
   */
  negligibleThinkAloud: boolean;
};

/**
 * Heuristic: a real on-site loop expects *some* ongoing narration or explanation while coding.
 * Below ~20 words total is almost always silence, mumbles, or a single short phrase.
 */
const NEGLIGIBLE_MAX_WORDS = 20;

export function buildCodingVoiceReport(
  entries: TranscriptEntry[]
): CodingVoiceReport {
  const text = entries.map((e) => e.text).join(" ");
  const wordCount =
    text.trim() === "" ? 0 : text.trim().split(/\s+/).filter((w) => w.length > 0).length;
  return {
    utteranceCount: entries.length,
    wordCount,
    negligibleThinkAloud: wordCount < NEGLIGIBLE_MAX_WORDS,
  };
}
