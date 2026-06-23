type Props = {
  chatOpen: boolean;
  onClick: () => void;
};

export function ChatToggleButton({ chatOpen, onClick }: Props) {
  const label = chatOpen ? "Hide chat" : "Show chat";
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-600 bg-zinc-800/80 px-2.5 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500"
      aria-label={chatOpen ? "Collapse chat panel" : "Open chat panel"}
      title={chatOpen ? "Collapse the chat panel" : "Open the chat panel"}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      {label}
    </button>
  );
}
