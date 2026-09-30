import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { PersistedInterviewSession } from "@/lib/interview-session-storage";

const LOCAL_DEBUG_DIR = join(process.cwd(), "local-debug");
let debugLogQueue: Promise<void> = Promise.resolve();
let interviewWriteQueue: Promise<void> = Promise.resolve();

export function appendLocalDebugEvent(
  event: Record<string, unknown>
): Promise<void> {
  if (process.env.NODE_ENV !== "development") return Promise.resolve();

  const append = debugLogQueue.then(async () => {
    await mkdir(LOCAL_DEBUG_DIR, { recursive: true });
    await appendFile(
      join(LOCAL_DEBUG_DIR, "debug.jsonl"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
      "utf8"
    );
  });
  debugLogQueue = append.catch(() => undefined);
  return append.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[local-debug-archive] Could not append event: ${message}`);
  });
}

export function writeLocalInterviewSnapshot(
  session: PersistedInterviewSession
): Promise<void> {
  if (process.env.NODE_ENV !== "development") return Promise.resolve();

  const write = interviewWriteQueue.then(() => writeInterviewSnapshot(session));
  interviewWriteQueue = write.catch(() => undefined);
  return write;
}

async function writeInterviewSnapshot(
  session: PersistedInterviewSession
): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(session.questionId)) {
    throw new Error("Invalid question id for local interview archive.");
  }

  const startedAt = Math.floor(session.roundStartTime ?? session.savedAt);
  const sessionsDir = join(LOCAL_DEBUG_DIR, "interviews");
  const filePath = join(
    sessionsDir,
    `${session.questionId}-${startedAt}.json`
  );
  try {
    const current = JSON.parse(await readFile(filePath, "utf8")) as {
      savedAt?: unknown;
    };
    if (
      typeof current.savedAt === "number" &&
      current.savedAt > session.savedAt
    ) {
      return;
    }
  } catch {
    // A new archive file, or an incomplete prior write, can be replaced.
  }
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(sessionsDir, { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[local-debug-archive] Could not save interview: ${message}`);
    throw error;
  }
}

export function redactDebugMessage(message: string): string {
  return message
    .replace(/\bsk-(?:or-v1-|ant-)?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]")
    .replace(/\b(?:sk_|gsk_)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_KEY]");
}
