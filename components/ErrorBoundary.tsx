"use client";

import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("InterviewWorkspace crashed:", error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    const message =
      this.state.error.message?.slice(0, 280) ?? "Unexpected error";
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 px-6 text-zinc-100">
        <div className="max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-sm">
          <h2 className="mb-2 text-base font-semibold text-rose-300">
            Something went wrong
          </h2>
          <p className="mb-4 text-zinc-400">
            The interview session hit an unexpected error. Your chat and code
            may still be intact — try reloading. If it keeps happening, copy
            the message below and check the dev console.
          </p>
          <pre className="mb-4 max-h-40 overflow-auto rounded bg-zinc-950 p-2 text-[11px] text-rose-200">
            {message}
          </pre>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={this.reset}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
