export type Snapshot = {
  code: string;
  transcript: string;
  timestamp: number;
};

const SNAPSHOT_MS = 15000;
const MAX_SNAPSHOTS = 20;
const SIGNIFICANT_DIFF_THRESHOLD = 20;
const FEEDBACK_SAMPLE_MIDDLE_MAX = 3;

let intervalId: ReturnType<typeof setInterval> | null = null;
const snapshots: Snapshot[] = [];

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const m = a.length;
  const n = b.length;
  if (m === 0) {
    return n;
  }
  if (n === 0) {
    return m;
  }
  const row = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) {
    row[j] = j;
  }
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n];
}

function capSnapshotsPreservingEnds(arr: Snapshot[], max: number): Snapshot[] {
  if (arr.length <= max) {
    return arr;
  }
  if (max === 0) {
    return [];
  }
  if (max === 1) {
    return [arr[0]];
  }
  const n = arr.length;
  const indices = new Set<number>();
  for (let k = 0; k < max; k++) {
    const idx = Math.round((k * (n - 1)) / Math.max(max - 1, 1));
    indices.add(Math.min(idx, n - 1));
  }
  return [...indices]
    .sort((a, b) => a - b)
    .map((i) => arr[i]);
}

export function startSnapshots(
  getCode: () => string,
  getTranscript: () => string
): void {
  stopSnapshots();
  snapshots.length = 0;
  intervalId = setInterval(() => {
    const snap: Snapshot = {
      code: getCode(),
      transcript: getTranscript(),
      timestamp: Date.now(),
    };
    if (snapshots.length >= MAX_SNAPSHOTS) {
      // Hard cap: sample-evict to keep first, last, and evenly spaced middle
      const next = [...snapshots, snap];
      snapshots.length = 0;
      snapshots.push(...capSnapshotsPreservingEnds(next, MAX_SNAPSHOTS));
    } else {
      snapshots.push(snap);
    }
  }, SNAPSHOT_MS);
}

export function stopSnapshots(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export function getSnapshots(): Snapshot[] {
  return [...snapshots];
}

/** Replace in-memory snapshots (e.g. when restoring a saved session). */
export function replaceSnapshots(next: Snapshot[]): void {
  snapshots.length = 0;
  for (const s of next) {
    snapshots.push(s);
  }
}

export function getSignificantSnapshots(): Snapshot[] {
  const all = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
  if (all.length === 0) {
    return [];
  }
  if (all.length === 1) {
    return [all[0]];
  }

  const includeIdx = new Set<number>();
  includeIdx.add(0);
  includeIdx.add(all.length - 1);

  for (let i = 1; i < all.length; i++) {
    const prev = all[i - 1].code;
    const curr = all[i].code;
    if (levenshtein(prev, curr) > SIGNIFICANT_DIFF_THRESHOLD) {
      includeIdx.add(i);
    }
  }

  const ordered = [...includeIdx]
    .sort((a, b) => a - b)
    .map((i) => all[i]);

  return capSnapshotsPreservingEnds(ordered, MAX_SNAPSHOTS);
}

/**
 * Returns a compact sample for the feedback payload:
 * first + last + up to FEEDBACK_SAMPLE_MIDDLE_MAX middle snapshots ranked by edit distance.
 * Keeps total payload small without losing coverage of the coding arc.
 */
export function getSampledFeedbackSnapshots(): Snapshot[] {
  const all = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
  if (all.length <= 2) {
    return all;
  }

  const first = all[0];
  const last = all[all.length - 1];
  const middle = all.slice(1, -1);

  // Rank middle snapshots by levenshtein distance to their predecessor
  const ranked = middle
    .map((snap, i) => ({
      snap,
      diff: levenshtein(all[i].code, snap.code),
    }))
    .sort((a, b) => b.diff - a.diff)
    .slice(0, FEEDBACK_SAMPLE_MIDDLE_MAX)
    .map((x) => x.snap)
    .sort((a, b) => a.timestamp - b.timestamp);

  return [first, ...ranked, last];
}
