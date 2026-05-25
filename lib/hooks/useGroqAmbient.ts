"use client";

import { useEffect, useRef } from "react";

import {
  startGroqAmbientRecording,
  type GroqAmbientHandle,
} from "@/lib/groq-ambient";

/**
 * Wraps the Groq Whisper ambient recording loop. Active only while `active` is
 * true (typically the coding phase). Calls `onTranscript` for each finalized
 * chunk and `onError` for permission/transport failures. Returns a ref to the
 * underlying handle so callers can pause/resume around focused mic captures or
 * AI streams.
 */
export function useGroqAmbient(
  active: boolean,
  onTranscript: (text: string) => void,
  onError: (error: string) => void
): React.MutableRefObject<GroqAmbientHandle | null> {
  const handleRef = useRef<GroqAmbientHandle | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (!active) {
      const h = handleRef.current;
      if (h) {
        h.stop();
        handleRef.current = null;
      }
      return;
    }

    let cancelled = false;
    void startGroqAmbientRecording(
      (text) => {
        if (cancelled) return;
        onTranscriptRef.current(text);
      },
      (error) => {
        if (cancelled) return;
        onErrorRef.current(error);
      }
    ).then((handle) => {
      if (cancelled || !handle) {
        handle?.stop();
        return;
      }
      handleRef.current = handle;
    });

    return () => {
      cancelled = true;
      const h = handleRef.current;
      handleRef.current = null;
      h?.stop();
    };
  }, [active]);

  return handleRef;
}
