import { loadProviderKeys } from "@/lib/byok";

const CHUNK_MS = 30_000;
/** Delay before starting the next recorder on the same stream (avoids browser handoff races). */
const CHUNK_RESTART_DELAY_MS = 50;

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "";
}

function isStreamLive(stream: MediaStream): boolean {
  const tracks = stream.getAudioTracks();
  return (
    tracks.length > 0 &&
    tracks.some((t) => t.readyState === "live" && t.enabled)
  );
}

async function transcribeChunk(blob: Blob, apiKey: string): Promise<string> {
  if (blob.size < 512) return "";
  const ext = blob.type.includes("mp4") ? "mp4" : "webm";
  const form = new FormData();
  form.append("file", blob, `audio.${ext}`);
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-provider-key"] = apiKey;
  try {
    const res = await fetch("/api/transcribe", { method: "POST", headers, body: form });
    if (!res.ok) return "";
    const data = (await res.json()) as { text?: string };
    return typeof data.text === "string" ? data.text.trim() : "";
  } catch {
    return "";
  }
}

export interface GroqAmbientHandle {
  /** Stop recording current chunk, send it to Groq in background, pause the loop. */
  pauseForFocus(): void;
  /** Restart the recording loop after a focused mic session. */
  resumeFromFocus(): void;
  /** Permanently stop, flush last chunk, and release the mic stream. */
  stop(): void;
}

/**
 * Start continuous ambient recording that sends 30-second audio chunks to Groq Whisper.
 * Each chunk is transcribed in the background; results are delivered via `onTranscript`.
 * Returns null if the user denies microphone access.
 */
export async function startGroqAmbientRecording(
  onTranscript: (text: string) => void,
  onError: (error: string) => void
): Promise<GroqAmbientHandle | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    onError(`Microphone access denied: ${msg}`);
    return null;
  }

  const mime = pickMimeType();
  const apiKey = loadProviderKeys().groq ?? "";

  let recorder: MediaRecorder | null = null;
  let chunks: BlobPart[] = [];
  let chunkTimer: ReturnType<typeof setTimeout> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let paused = false;
  /** Bumped on pause/stop so in-flight deferred chunk starts are ignored. */
  let loopGeneration = 0;
  let chunkStarting = false;

  function clearRestartTimer() {
    if (restartTimer !== null) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  }

  function flushBackground() {
    if (chunks.length === 0) return;
    const blob = new Blob(chunks, { type: mime || "audio/webm" });
    chunks = [];
    void transcribeChunk(blob, apiKey).then((text) => {
      if (text && !stopped) onTranscript(text);
    });
  }

  function failAmbient(message: string) {
    if (stopped) return;
    stopped = true;
    loopGeneration += 1;
    clearRestartTimer();
    stopCurrentRecorder();
    stream.getTracks().forEach((t) => t.stop());
    onError(message);
  }

  function scheduleNextChunk() {
    if (stopped || paused) return;
    clearRestartTimer();
    const gen = loopGeneration;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopped || paused || gen !== loopGeneration) return;
      void beginChunk();
    }, CHUNK_RESTART_DELAY_MS);
  }

  function beginChunk(): void {
    if (stopped || paused || chunkStarting) return;

    if (!isStreamLive(stream)) {
      failAmbient(
        "Microphone stream ended. Ambient voice capture stopped — check your mic and refresh if needed."
      );
      return;
    }

    const active = recorder;
    if (active && active.state !== "inactive") {
      scheduleNextChunk();
      return;
    }

    chunkStarting = true;
    chunks = [];

    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      chunkStarting = false;
      const msg = e instanceof Error ? e.message : String(e);
      failAmbient(`Ambient recording unavailable: ${msg}`);
      return;
    }

    recorder = rec;

    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    rec.onerror = () => {
      if (recorder !== rec || stopped) return;
      failAmbient("Ambient recording error — voice capture stopped.");
    };

    rec.onstop = () => {
      if (recorder === rec) {
        recorder = null;
      }
      flushBackground();
      if (!stopped && !paused) {
        scheduleNextChunk();
      }
    };

    try {
      rec.start();
    } catch (e) {
      chunkStarting = false;
      if (recorder === rec) {
        recorder = null;
      }
      const msg = e instanceof Error ? e.message : String(e);
      onError(
        `Could not start ambient recording (${msg}). Retrying shortly…`
      );
      scheduleNextChunk();
      return;
    }

    chunkStarting = false;

    chunkTimer = setTimeout(() => {
      chunkTimer = null;
      if (recorder === rec && !stopped && !paused && rec.state === "recording") {
        try {
          rec.stop();
        } catch {
          flushBackground();
          scheduleNextChunk();
        }
      }
    }, CHUNK_MS);
  }

  function stopCurrentRecorder() {
    if (chunkTimer !== null) {
      clearTimeout(chunkTimer);
      chunkTimer = null;
    }
    const rec = recorder;
    recorder = null;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        flushBackground();
      }
    }
  }

  scheduleNextChunk();

  return {
    pauseForFocus() {
      paused = true;
      loopGeneration += 1;
      clearRestartTimer();
      stopCurrentRecorder();
    },
    resumeFromFocus() {
      if (stopped) return;
      paused = false;
      scheduleNextChunk();
    },
    stop() {
      stopped = true;
      paused = true;
      loopGeneration += 1;
      clearRestartTimer();
      stopCurrentRecorder();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}
