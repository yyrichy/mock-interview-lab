"use client";

import { useEffect, useRef, useState } from "react";

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

export interface FocusMicRecorder {
  /** True while the post-release Groq Whisper transcription is running. */
  transcribing: boolean;
  /**
   * Open the mic and start a hold-to-record session. Stops automatically if
   * `heldRef.current` is false when the stream resolves (the user released
   * before mic permission came through).
   */
  startHold(heldRef: React.MutableRefObject<boolean>): Promise<void>;
  /** Stop recording and return the captured blob (or null if too short). */
  stopToBlob(): Promise<Blob | null>;
  /**
   * Force-tear-down without producing a blob. Used on unmount, session reset,
   * and after a `startHold` error to release the OS mic immediately.
   */
  abort(): void;
  setTranscribing(v: boolean): void;
}

export function useFocusMicRecorder(): FocusMicRecorder {
  const [transcribing, setTranscribing] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const mimeRef = useRef("");

  function abort(): void {
    const rec = recorderRef.current;
    recorderRef.current = null;
    const stream = streamRef.current;
    streamRef.current = null;
    chunksRef.current = [];
    mimeRef.current = "";
    if (rec && rec.state === "recording") {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    stream?.getTracks().forEach((t) => t.stop());
  }

  // Release the OS mic if the host component unmounts mid-record.
  useEffect(() => {
    return () => {
      abort();
    };
  }, []);

  async function startHold(
    heldRef: React.MutableRefObject<boolean>
  ): Promise<void> {
    mimeRef.current = "";
    chunksRef.current = [];
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!heldRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;
    const mime = pickMime();
    mimeRef.current = mime.includes("mp4") ? "audio/mp4" : "audio/webm";
    const rec = new MediaRecorder(
      stream,
      mime.length > 0 ? { mimeType: mime } : undefined
    );
    recorderRef.current = rec;
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) {
        chunksRef.current.push(e.data);
      }
    };
    if (!heldRef.current) {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      stream.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      streamRef.current = null;
      return;
    }
    rec.start();
  }

  function stopToBlob(): Promise<Blob | null> {
    const rec = recorderRef.current;
    recorderRef.current = null;
    const stream = streamRef.current;
    streamRef.current = null;
    if (!rec) {
      stream?.getTracks().forEach((t) => t.stop());
      chunksRef.current = [];
      mimeRef.current = "";
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      rec.onstop = () => {
        stream?.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, {
          type: mimeRef.current || "audio/webm",
        });
        chunksRef.current = [];
        mimeRef.current = "";
        resolve(blob.size >= 256 ? blob : null);
      };
      try {
        rec.stop();
      } catch {
        stream?.getTracks().forEach((t) => t.stop());
        chunksRef.current = [];
        mimeRef.current = "";
        resolve(null);
      }
    });
  }

  return {
    transcribing,
    startHold,
    stopToBlob,
    abort,
    setTranscribing,
  };
}
