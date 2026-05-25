"use client";

import { useState } from "react";
import {
  loadProviderKeys,
  saveProviderKeys,
  type ProviderKeyId,
  type ProviderKeys,
} from "@/lib/byok";

type Props = {
  onClose: () => void;
};

const PROVIDERS: { id: ProviderKeyId; label: string; placeholder: string }[] = [
  { id: "gemini", label: "Gemini", placeholder: "AIza…" },
  { id: "groq", label: "Groq", placeholder: "gsk_…" },
  { id: "anthropic", label: "Anthropic", placeholder: "sk-ant-…" },
  { id: "openai", label: "OpenAI", placeholder: "sk-…" },
  { id: "elevenlabs", label: "ElevenLabs", placeholder: "sk_…" },
];

export function ByokDrawer({ onClose }: Props) {
  const [keys, setKeys] = useState<ProviderKeys>(() => loadProviderKeys());
  const [saved, setSaved] = useState(false);
  const [visible, setVisible] =
    useState<Partial<Record<ProviderKeyId, boolean>>>({});

  function handleSave() {
    saveProviderKeys(keys);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function handleClear() {
    const cleared = Object.fromEntries(
      PROVIDERS.map(({ id }) => [id, ""])
    ) as ProviderKeys;
    setKeys(cleared);
    saveProviderKeys(cleared);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">
            API Keys (BYOK)
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            Close
          </button>
        </div>

        <p className="mb-4 text-[11px] leading-relaxed text-zinc-500">
          Keys are stored only in your browser&apos;s localStorage and sent via a
          request header — never logged or persisted by the server. Leave a field
          empty to fall back to the server&apos;s environment key.
        </p>

        <div className="flex flex-col gap-3">
          {PROVIDERS.map(({ id, label, placeholder }) => (
            <label key={id} className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                {label}
              </span>
              <div className="flex gap-1.5">
                <input
                  type={visible[id] ? "text" : "password"}
                  value={keys[id] ?? ""}
                  onChange={(e) =>
                    setKeys((prev) => ({ ...prev, [id]: e.target.value }))
                  }
                  placeholder={placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-zinc-700 focus:border-zinc-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() =>
                    setVisible((prev) => ({ ...prev, [id]: !prev[id] }))
                  }
                  className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-[11px] text-zinc-400 hover:text-zinc-200"
                  aria-label={visible[id] ? "Hide key" : "Show key"}
                >
                  {visible[id] ? "Hide" : "Show"}
                </button>
              </div>
            </label>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={handleClear}
            className="text-[11px] text-zinc-500 hover:text-zinc-300"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600"
          >
            {saved ? "Saved!" : "Save keys"}
          </button>
        </div>
      </div>
    </div>
  );
}
