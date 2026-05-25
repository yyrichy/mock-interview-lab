"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { TestResultsPanel } from "@/components/TestResultsPanel";
import type { TestResult } from "@/lib/judge0";

/** Default share of the coding column given to test results (editor keeps the rest). */
const DEFAULT_FRACTION = 0.38;
const MIN_FRACTION = 0.12;
const MAX_FRACTION = 0.72;
/** Fallback height (px) for the very first paint before we can measure the parent. */
const INITIAL_FALLBACK_PX = 160;

type Props = {
  results: TestResult[] | null;
  allPassed: boolean | null;
  loading: boolean;
  error: string | null;
};

function hasPanelContent(
  loading: boolean,
  error: string | null,
  results: TestResult[] | null
): boolean {
  return (
    loading ||
    !!error ||
    (results !== null && results.length > 0)
  );
}

/**
 * Bottom test-results pane: capped height by default (~38%), scrollable content,
 * drag handle on the top edge to resize between editor and results.
 *
 * Visibility is hoisted to this wrapper so the inner pane's measurement state
 * naturally resets via mount/unmount instead of an effect-driven setState.
 */
export function ResizableTestResultsSection(props: Props) {
  const visible = hasPanelContent(props.loading, props.error, props.results);
  if (!visible) {
    return null;
  }
  return <VisiblePane {...props} />;
}

function VisiblePane({ results, allPassed, loading, error }: Props) {
  const splitRef = useRef<HTMLDivElement | null>(null);
  const [heightPx, setHeightPx] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const heightPxRef = useRef<number | null>(heightPx);

  useEffect(() => {
    heightPxRef.current = heightPx;
  }, [heightPx]);

  const clampHeight = useCallback((px: number) => {
    const parent = splitRef.current?.parentElement;
    if (!parent) {
      return px;
    }
    const parentH = parent.clientHeight;
    const minH = Math.round(parentH * MIN_FRACTION);
    const maxH = Math.round(parentH * MAX_FRACTION);
    return Math.min(maxH, Math.max(minH, px));
  }, []);

  // Callback ref: fires when the DOM node attaches. Measures the parent and
  // seeds heightPx once. This avoids the "setState in effect" pattern that
  // react-hooks/set-state-in-effect (rightly) discourages for prop-driven
  // resets, but is the canonical place to bridge DOM measurement into state.
  const attachRef = useCallback((node: HTMLDivElement | null) => {
    splitRef.current = node;
    if (node && heightPxRef.current === null) {
      const parent = node.parentElement;
      if (parent) {
        setHeightPx(Math.round(parent.clientHeight * DEFAULT_FRACTION));
      }
    }
  }, []);

  useEffect(() => {
    const parent = splitRef.current?.parentElement;
    if (!parent) {
      return;
    }
    const ro = new ResizeObserver(() => {
      const h = heightPxRef.current;
      if (h === null) {
        return;
      }
      const clamped = clampHeight(h);
      if (clamped !== h) {
        setHeightPx(clamped);
      }
    });
    ro.observe(parent);
    return () => ro.disconnect();
  }, [clampHeight]);

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) {
        return;
      }
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const parent = splitRef.current?.parentElement;
      if (!parent) {
        return;
      }
      const startH =
        heightPxRef.current ?? Math.round(parent.clientHeight * DEFAULT_FRACTION);

      const onMove = (ev: PointerEvent) => {
        const delta = startY - ev.clientY;
        setHeightPx(clampHeight(startH + delta));
      };
      const onUp = (ev: PointerEvent) => {
        (e.target as HTMLElement).releasePointerCapture(ev.pointerId);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [clampHeight, collapsed]
  );

  const h = collapsed ? undefined : heightPx ?? INITIAL_FALLBACK_PX;
  const headerLabel =
    loading
      ? "Running tests..."
      : error
        ? "Test run failed"
        : allPassed === true
          ? "All tests passed"
          : allPassed === false
            ? "Some tests failed"
            : "Test results";

  return (
    <div
      ref={attachRef}
      className="flex shrink-0 flex-col border-t border-zinc-800 bg-zinc-900/50"
      style={collapsed ? undefined : { height: h }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize test results panel"
        aria-valuenow={collapsed ? undefined : h}
        onPointerDown={onResizePointerDown}
        className={`group flex h-2.5 shrink-0 touch-none items-center justify-center border-b border-zinc-800/80 bg-zinc-900 hover:bg-zinc-800 ${
          collapsed ? "cursor-default" : "cursor-row-resize"
        }`}
      >
        <span className="h-0.5 w-12 rounded-full bg-zinc-600 transition-colors group-hover:bg-zinc-400 group-active:bg-emerald-500/80" />
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800/80 px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-300">
          {headerLabel}
        </p>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-zinc-500 hover:bg-zinc-800"
          aria-expanded={!collapsed}
        >
          {collapsed ? "Show details" : "Collapse"}
        </button>
      </div>
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TestResultsPanel
            results={results}
            allPassed={allPassed}
            loading={loading}
            error={error}
          />
        </div>
      )}
    </div>
  );
}
