"use client";

import { ScorecardWidget } from "@/components/ScorecardWidget";

/**
 * Renders assistant text; if it contains markdown ## headings (feedback format),
 * shows distinct sections. The ## Score section is rendered as a scorecard widget.
 * Otherwise plain pre-wrapped text.
 */
export function AssistantMessageBody({ content }: { content: string }) {
  if (!/^## /m.test(content)) {
    return <span className="whitespace-pre-wrap">{content}</span>;
  }

  const blocks = content.split(/\n(?=## )/).filter((b) => b.length > 0);

  return (
    <div className="flex flex-col gap-4">
      {blocks.map((block, i) => {
        const trimmed = block.trimStart();
        if (!trimmed.startsWith("## ")) {
          return (
            <p key={i} className="whitespace-pre-wrap text-zinc-200">
              {block.trimEnd()}
            </p>
          );
        }
        const newlineIdx = trimmed.indexOf("\n");
        const titleLine =
          newlineIdx === -1 ? trimmed : trimmed.slice(0, newlineIdx);
        const title = titleLine.replace(/^##\s+/, "").trim();
        const body =
          newlineIdx === -1 ? "" : trimmed.slice(newlineIdx + 1).trim();

        if (title.toLowerCase() === "score") {
          return (
            <section key={i} className="border-l-2 border-emerald-700/50 pl-3">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-400/95">
                {title}
              </h3>
              <ScorecardWidget raw={body} />
            </section>
          );
        }

        return (
          <section key={i} className="border-l-2 border-emerald-700/50 pl-3">
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-400/95">
              {title}
            </h3>
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
              {body}
            </div>
          </section>
        );
      })}
    </div>
  );
}
