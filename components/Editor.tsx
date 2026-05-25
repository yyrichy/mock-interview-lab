"use client";

import dynamic from "next/dynamic";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[200px] items-center justify-center bg-[#1e1e1e] text-sm text-zinc-500">
      Loading editor…
    </div>
  ),
});

type Props = {
  initialValue: string;
  className?: string;
  readOnly?: boolean;
  /** Pad realism: disables minimap, autocomplete, bracket hints; blocks paste. */
  padRealism?: boolean;
  onChange?: (value: string) => void;
};

export function Editor({ initialValue, className, readOnly, padRealism, onChange }: Props) {
  const isPad = padRealism && !readOnly;
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 flex-col bg-[#1e1e1e] ${className ?? ""}`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
        <span className="text-xs font-medium text-zinc-400">Python</span>
        {isPad && (
          <span className="text-[10px] font-medium text-amber-500/80 uppercase tracking-wide">
            Pad mode
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <MonacoEditor
          height="100%"
          language="python"
          theme="vs-dark"
          defaultValue={initialValue}
          onChange={(value) => onChange?.(value ?? "")}
          options={{
            fontSize: 14,
            minimap: { enabled: !isPad },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 4,
            wordWrap: "on",
            readOnly: readOnly ?? false,
            autoClosingBrackets: isPad ? "never" : "always",
            autoClosingQuotes: isPad ? "never" : "always",
            parameterHints: { enabled: !isPad },
            suggestOnTriggerCharacters: !isPad,
            quickSuggestions: !isPad,
          }}
          onMount={(editor, monacoInstance) => {
            if (!isPad) return;
            editor.addCommand(
              monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyV,
              () => {
                // paste blocked — rely on parent toast
              }
            );
            editor.onDidPaste(() => {
              editor.trigger("keyboard", "undo", null);
            });
          }}
        />
      </div>
    </div>
  );
}
