export default function Loading() {
  return (
    <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-300">
      <div className="flex items-center gap-3 text-sm">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500 [animation-delay:150ms]" />
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500 [animation-delay:300ms]" />
        <span className="ml-2 text-zinc-400">Loading interview…</span>
      </div>
    </div>
  );
}
