"use client";

type ScoreDim = { label: string; score: number };

function parseDims(raw: string): ScoreDim[] {
  const order: { key: string; label: string }[] = [
    { key: "clarify", label: "Clarify" },
    { key: "algo", label: "Algo" },
    { key: "code", label: "Code" },
    { key: "verification", label: "Verify" },
    { key: "comms", label: "Comms" },
  ];
  return order.flatMap(({ key, label }) => {
    const m = raw.match(new RegExp(`${key}=(\\d)`));
    if (!m) return [];
    const n = parseInt(m[1], 10);
    if (n < 1 || n > 5) return [];
    return [{ label, score: n }];
  });
}

export function ScorecardWidget({ raw }: { raw: string }) {
  const dims = parseDims(raw);
  if (dims.length === 0) {
    return <p className="text-sm text-zinc-400">{raw}</p>;
  }
  return (
    <div className="flex flex-wrap gap-3 pt-1">
      {dims.map(({ label, score }) => (
        <div key={label} className="flex flex-col items-center gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">
            {label}
          </span>
          <div className="flex gap-0.5">
            {[1, 2, 3, 4, 5].map((n) => (
              <span
                key={n}
                className={`inline-block h-2.5 w-2.5 rounded-sm ${
                  n <= score ? "bg-emerald-500" : "bg-zinc-700"
                }`}
              />
            ))}
          </div>
          <span className="text-[10px] text-zinc-400">{score}/5</span>
        </div>
      ))}
    </div>
  );
}
