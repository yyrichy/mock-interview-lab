"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import type { Question } from "@/lib/questions";

type Props = {
  questions: Question[];
  allLabels: string[];
  allCompanies: string[];
  allDifficulties: string[];
};

type GroupBy = "none" | "difficulty" | "label" | "company";

function difficultyStyles(difficulty: string): string {
  const d = difficulty.toLowerCase();
  if (d === "easy") {
    return "border-emerald-600/50 bg-emerald-500/15 text-emerald-200";
  }
  if (d === "medium") {
    return "border-amber-600/45 bg-amber-500/12 text-amber-100";
  }
  if (d === "hard") {
    return "border-rose-600/45 bg-rose-500/12 text-rose-100";
  }
  return "border-zinc-600 bg-zinc-800/80 text-zinc-300";
}

function ChipButton({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count?: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
        selected
          ? "border-zinc-300 bg-zinc-100 text-zinc-900"
          : "border-zinc-700 bg-zinc-900/60 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800"
      }`}
    >
      <span>{label}</span>
      {typeof count === "number" && (
        <span
          className={`ml-1.5 text-[10px] ${
            selected ? "text-zinc-500" : "text-zinc-500"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function MetaChip({ children, tone }: { children: React.ReactNode; tone?: "muted" | "label" }) {
  const base = "rounded-md border px-1.5 py-0.5 text-[10px] font-medium tracking-wide";
  if (tone === "label") {
    return (
      <span className={`${base} border-sky-700/40 bg-sky-500/10 text-sky-200`}>{children}</span>
    );
  }
  return (
    <span className={`${base} border-zinc-700 bg-zinc-800/60 text-zinc-400 lowercase`}>{children}</span>
  );
}

function toggleInSet(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

function QuestionCard({ q }: { q: Question }) {
  return (
    <Link
      href={`/interview/${q.id}`}
      className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-4 transition hover:border-zinc-600 hover:bg-zinc-900/70"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-medium text-zinc-100">{q.title}</span>
        <span
          className={`shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium uppercase tracking-wide ${difficultyStyles(q.difficulty)}`}
        >
          {q.difficulty}
        </span>
      </div>
      {q.labels && q.labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {q.labels.map((l) => (
            <MetaChip key={l} tone="label">
              {l}
            </MetaChip>
          ))}
        </div>
      )}
      {q.company && q.company.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {q.company.map((c) => (
            <MetaChip key={c}>{c}</MetaChip>
          ))}
        </div>
      )}
    </Link>
  );
}

export default function QuestionBrowser({
  questions,
  allLabels,
  allCompanies,
  allDifficulties,
}: Props) {
  const [search, setSearch] = useState("");
  const [selectedDifficulties, setSelectedDifficulties] = useState<Set<string>>(new Set());
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());
  const [selectedCompanies, setSelectedCompanies] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [showAllCompanies, setShowAllCompanies] = useState(false);
  const [showAllLabels, setShowAllLabels] = useState(false);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return questions.filter((q) => {
      if (term && !q.title.toLowerCase().includes(term)) {
        return false;
      }
      if (selectedDifficulties.size > 0 && !selectedDifficulties.has(q.difficulty.toLowerCase())) {
        return false;
      }
      if (selectedLabels.size > 0) {
        const labels = q.labels ?? [];
        for (const l of selectedLabels) {
          if (!labels.includes(l)) {
            return false;
          }
        }
      }
      if (selectedCompanies.size > 0) {
        const companies = q.company ?? [];
        let hit = false;
        for (const c of selectedCompanies) {
          if (companies.includes(c)) {
            hit = true;
            break;
          }
        }
        if (!hit) {
          return false;
        }
      }
      return true;
    });
  }, [questions, search, selectedDifficulties, selectedLabels, selectedCompanies]);

  const labelCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const q of questions) {
      for (const l of q.labels ?? []) {
        m.set(l, (m.get(l) ?? 0) + 1);
      }
    }
    return m;
  }, [questions]);

  const companyCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const q of questions) {
      for (const c of q.company ?? []) {
        m.set(c, (m.get(c) ?? 0) + 1);
      }
    }
    return m;
  }, [questions]);

  const difficultyCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const q of questions) {
      m.set(q.difficulty.toLowerCase(), (m.get(q.difficulty.toLowerCase()) ?? 0) + 1);
    }
    return m;
  }, [questions]);

  const grouped = useMemo<{ key: string; items: Question[] }[]>(() => {
    if (groupBy === "none") {
      return [{ key: "All questions", items: filtered }];
    }
    const buckets = new Map<string, Question[]>();
    for (const q of filtered) {
      const keys: string[] =
        groupBy === "difficulty"
          ? [q.difficulty.toLowerCase()]
          : groupBy === "label"
            ? q.labels && q.labels.length > 0
              ? q.labels
              : ["(no label)"]
            : q.company && q.company.length > 0
              ? q.company
              : ["(no company)"];
      for (const k of keys) {
        const list = buckets.get(k) ?? [];
        list.push(q);
        buckets.set(k, list);
      }
    }
    const order =
      groupBy === "difficulty"
        ? allDifficulties
        : groupBy === "label"
          ? allLabels
          : allCompanies;
    const result: { key: string; items: Question[] }[] = [];
    for (const k of order) {
      if (buckets.has(k)) {
        result.push({ key: k, items: buckets.get(k) ?? [] });
        buckets.delete(k);
      }
    }
    for (const [k, items] of buckets) {
      result.push({ key: k, items });
    }
    return result;
  }, [filtered, groupBy, allDifficulties, allLabels, allCompanies]);

  const hasActiveFilters =
    search.length > 0 ||
    selectedDifficulties.size > 0 ||
    selectedLabels.size > 0 ||
    selectedCompanies.size > 0;

  const visibleCompanies = showAllCompanies ? allCompanies : allCompanies.slice(0, 12);
  const visibleLabels = showAllLabels ? allLabels : allLabels.slice(0, 12);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search questions by title..."
          className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none"
        />

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Difficulty
            </span>
            {selectedDifficulties.size > 0 && (
              <button
                type="button"
                onClick={() => setSelectedDifficulties(new Set())}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                clear
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {allDifficulties.map((d) => (
              <ChipButton
                key={d}
                label={d}
                count={difficultyCounts.get(d) ?? 0}
                selected={selectedDifficulties.has(d)}
                onClick={() => setSelectedDifficulties((s) => toggleInSet(s, d))}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Label
            </span>
            {selectedLabels.size > 0 && (
              <button
                type="button"
                onClick={() => setSelectedLabels(new Set())}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                clear
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {visibleLabels.map((l) => (
              <ChipButton
                key={l}
                label={l}
                count={labelCounts.get(l) ?? 0}
                selected={selectedLabels.has(l)}
                onClick={() => setSelectedLabels((s) => toggleInSet(s, l))}
              />
            ))}
            {allLabels.length > 12 && (
              <button
                type="button"
                onClick={() => setShowAllLabels((v) => !v)}
                className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
              >
                {showAllLabels ? "show fewer" : `+${allLabels.length - 12} more`}
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Company
            </span>
            {selectedCompanies.size > 0 && (
              <button
                type="button"
                onClick={() => setSelectedCompanies(new Set())}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                clear
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {visibleCompanies.map((c) => (
              <ChipButton
                key={c}
                label={c}
                count={companyCounts.get(c) ?? 0}
                selected={selectedCompanies.has(c)}
                onClick={() => setSelectedCompanies((s) => toggleInSet(s, c))}
              />
            ))}
            {allCompanies.length > 12 && (
              <button
                type="button"
                onClick={() => setShowAllCompanies((v) => !v)}
                className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
              >
                {showAllCompanies ? "show fewer" : `+${allCompanies.length - 12} more`}
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-3">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span>Group by</span>
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as GroupBy)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:border-zinc-500 focus:outline-none"
            >
              <option value="none">none</option>
              <option value="difficulty">difficulty</option>
              <option value="label">label</option>
              <option value="company">company</option>
            </select>
          </div>
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <span>
              {filtered.length} / {questions.length} question
              {questions.length === 1 ? "" : "s"}
            </span>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setSelectedDifficulties(new Set());
                  setSelectedLabels(new Set());
                  setSelectedCompanies(new Set());
                }}
                className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800"
              >
                reset all
              </button>
            )}
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
          No questions match these filters. Try clearing one.
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {grouped.map((g) => (
            <section key={g.key} className="flex flex-col gap-3">
              {groupBy !== "none" && (
                <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  {g.key}
                  <span className="ml-2 font-normal text-zinc-600">({g.items.length})</span>
                </h2>
              )}
              <ul className="flex flex-col gap-3">
                {g.items.map((q) => (
                  <li key={`${g.key}-${q.id}`}>
                    <QuestionCard q={q} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
