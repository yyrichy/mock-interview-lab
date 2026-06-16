import questionsData from "@/data/questions.demo.json";
import type { HiddenTestCase } from "@/lib/judge0";

export type FollowUp = {
  id: string;
  /** Prompt the interviewer delivers to introduce this variant. */
  prompt: string;
  /** Estimated minutes needed — used to decide whether to fire based on remaining time. */
  expectedMinutes: number;
  /**
   * Graded Python entry function for this variant when its contract (arity or
   * return type) differs from the baseline's — e.g. `three_sum` for a Two Sum
   * variant. The candidate defines it ALONGSIDE their existing code (the old
   * function stays, harmlessly). The variant prompt must state the exact
   * `def` line. Absent = the baseline entryFunction is graded.
   */
  entryFunction?: string;
  /**
   * Visible test cases for this variant (same schema as baseline testCases —
   * candidate-safe). When present, Run/Submit for this variant grade against
   * THESE instead of the baseline's; see resolveFollowUpTestSets.
   */
  testCases?: { input: string; expected: string }[];
  /** Optional hidden test cases for this variant (same schema as baseline). */
  hiddenTestCases?: HiddenTestCase[];
};

export type Question = {
  id: string;
  title: string;
  difficulty: string;
  company?: string[];
  /** Pattern tags from a fixed taxonomy (see docs/question-bank-research.md). */
  labels?: string[];
  /** Python function name Judge0 calls with unpacked test `input` JSON array args. */
  entryFunction: string;
  candidateDescription: string;
  interviewerContext: string;
  starterCode: string;
  testCases: { input: string; expected: string }[];
  hiddenTestCases?: HiddenTestCase[];
  /** Ordered list of follow-up variants fired after baseline is solved. */
  followUps?: FollowUp[];
};

/** A follow-up variant with its server-only hidden test cases stripped. */
export type PublicFollowUp = Omit<FollowUp, "hiddenTestCases">;

/**
 * Browser-safe Question. The grading fields the model uses but the candidate
 * must never see — `interviewerContext` and every `hiddenTestCases` array
 * (baseline AND per-follow-up) — are removed. This is the ONLY question shape a
 * client component may receive. Never widen it back toward `Question` across the
 * client boundary; load the full `Question` server-side instead.
 */
export type PublicQuestion = Omit<
  Question,
  "interviewerContext" | "hiddenTestCases" | "followUps"
> & {
  followUps?: PublicFollowUp[];
};

const questions = questionsData as Question[];

/**
 * Strip every server-only grading field from a Question. Whitelist (not
 * blacklist) construction: a new sensitive field added to Question will NOT leak
 * to the browser unless it is explicitly added here.
 */
export function toPublicQuestion(question: Question): PublicQuestion {
  return {
    id: question.id,
    title: question.title,
    difficulty: question.difficulty,
    company: question.company,
    labels: question.labels,
    entryFunction: question.entryFunction,
    candidateDescription: question.candidateDescription,
    starterCode: question.starterCode,
    testCases: question.testCases,
    followUps: question.followUps?.map((f) => ({
      id: f.id,
      prompt: f.prompt,
      expectedMinutes: f.expectedMinutes,
      entryFunction: f.entryFunction,
      testCases: f.testCases,
    })),
  };
}

/**
 * The test sets a Run/Submit should grade against, given which task is active.
 * All-or-nothing: a variant that defines its own visible testCases brings its
 * complete grading set (its hidden cases or none) — never a mix of variant
 * visible + baseline hidden, which would grade two different problems at once.
 * A variant with no testCases inherits the baseline wholesale (legacy data).
 * Unknown followUpId falls back to baseline rather than failing the run.
 */
export function resolveFollowUpTestSets(
  question: Question,
  followUpId: string | null | undefined
): {
  entryFunction: string;
  testCases: { input: string; expected: string }[];
  hiddenTestCases: HiddenTestCase[];
} {
  const followUp = followUpId
    ? question.followUps?.find((f) => f.id === followUpId)
    : undefined;
  // Independent of the test-set choice: an active variant's own entry function
  // is always graded when it defines one (a variant that changes the function
  // contract needs its own callable regardless of where its cases come from).
  const entryFunction = followUp?.entryFunction ?? question.entryFunction;
  if (followUp?.testCases && followUp.testCases.length > 0) {
    return {
      entryFunction,
      testCases: followUp.testCases,
      hiddenTestCases: followUp.hiddenTestCases ?? [],
    };
  }
  return {
    entryFunction,
    testCases: question.testCases,
    hiddenTestCases: question.hiddenTestCases ?? [],
  };
}

export function getQuestionById(id: string): Question | undefined {
  return questions.find((q) => q.id === id);
}

/** Browser-safe lookup: full question minus server-only grading fields. */
export function getPublicQuestionById(id: string): PublicQuestion | undefined {
  const question = getQuestionById(id);
  return question ? toPublicQuestion(question) : undefined;
}

/** Browser-safe list for the question browser. */
export function getAllPublicQuestions(): PublicQuestion[] {
  return questions.map(toPublicQuestion);
}

export function getAllQuestionIds(): string[] {
  return questions.map((q) => q.id);
}

export function getAllQuestions(): Question[] {
  return [...questions];
}

const DIFFICULTY_ORDER: Record<string, number> = {
  easy: 0,
  medium: 1,
  hard: 2,
};

export function compareQuestions(a: PublicQuestion, b: PublicQuestion): number {
  const da = DIFFICULTY_ORDER[a.difficulty.toLowerCase()] ?? 99;
  const db = DIFFICULTY_ORDER[b.difficulty.toLowerCase()] ?? 99;
  if (da !== db) {
    return da - db;
  }
  return a.title.localeCompare(b.title);
}

export function getAllLabels(): string[] {
  const set = new Set<string>();
  for (const q of questions) {
    for (const l of q.labels ?? []) {
      set.add(l);
    }
  }
  return [...set].sort();
}

export function getAllCompanies(): string[] {
  const set = new Set<string>();
  for (const q of questions) {
    for (const c of q.company ?? []) {
      set.add(c);
    }
  }
  return [...set].sort();
}

export function getAllDifficulties(): string[] {
  const set = new Set<string>();
  for (const q of questions) {
    set.add(q.difficulty.toLowerCase());
  }
  return [...set].sort(
    (a, b) => (DIFFICULTY_ORDER[a] ?? 99) - (DIFFICULTY_ORDER[b] ?? 99)
  );
}

/** Problem text as Python line comments + starter code for Monaco. */
/** Plain problem text for AI prompts (opening, feedback). */
export function questionToProblemStatement(question: PublicQuestion): string {
  const lines: string[] = [
    question.title,
    `Difficulty: ${question.difficulty}`,
  ];
  if (question.company?.length) {
    lines.push(`Companies: ${question.company.join(", ")}`);
  }
  lines.push("", question.candidateDescription);
  if (question.testCases.length > 0) {
    lines.push("", "Examples:");
    for (const tc of question.testCases) {
      lines.push(`- Input: ${tc.input}  →  Expected: ${tc.expected}`);
    }
  }
  return lines.join("\n");
}

export function questionToEditorInitialValue(question: PublicQuestion): string {
  const lines: string[] = [];
  lines.push(`# ${question.title}`);
  lines.push(`# Difficulty: ${question.difficulty}`);
  // if (question.company?.length) {
  //   lines.push(`# Companies: ${question.company.join(", ")}`);
  // }
  lines.push("#");
  for (const raw of question.candidateDescription.split("\n")) {
    lines.push(raw.length === 0 ? "#" : `# ${raw}`);
  }
  if (question.testCases.length > 0) {
    lines.push("#");
    lines.push("# Test cases (examples):");
    for (const tc of question.testCases) {
      lines.push(`#   input: ${tc.input}  →  expected: ${tc.expected}`);
    }
  }
  lines.push("#");
  lines.push("");
  return `${lines.join("\n")}${question.starterCode}`;
}

export function questionToInterviewerContext(question: Question): string {
  return question.interviewerContext;
}