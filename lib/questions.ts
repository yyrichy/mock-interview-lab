import questionsData from "@/data/questions.json";
import type { HiddenTestCase } from "@/lib/judge0";

export type FollowUp = {
  id: string;
  /** Prompt the interviewer delivers to introduce this variant. */
  prompt: string;
  /** Estimated minutes needed — used to decide whether to fire based on remaining time. */
  expectedMinutes: number;
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

const questions = questionsData as Question[];

export function getQuestionById(id: string): Question | undefined {
  return questions.find((q) => q.id === id);
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

export function compareQuestions(a: Question, b: Question): number {
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
export function questionToProblemStatement(question: Question): string {
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

export function questionToEditorInitialValue(question: Question): string {
  const lines: string[] = [];
  lines.push(`# ${question.title}`);
  lines.push(`# Difficulty: ${question.difficulty}`);
  if (question.company?.length) {
    lines.push(`# Companies: ${question.company.join(", ")}`);
  }
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