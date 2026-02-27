import { useState, useRef, useCallback, useEffect } from "react";
import { api } from "../api.js";

export type RecordingState = "idle" | "requesting" | "recording" | "transcribing" | "error";

const MAX_RECORDING_MS = 60_000;

interface UseAudioRecorderOptions {
  onTranscript: (text: string) => void;
  onError: (error: string) => void;
  keywords?: string;
}

export function useAudioRecorder({ onTranscript, onError, keywords }: UseAudioRecorderOptions) {
  const [state, setState] = useState<RecordingState>("idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Store latest callbacks in refs so the MediaRecorder.onstop closure always sees the current version
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const keywordsRef = useRef(keywords);
  keywordsRef.current = keywords;

  const cleanup = useCallback(() => {
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.onstop = null;
        mediaRecorderRef.current.stop();
      }
      cleanup();
    };
  }, [cleanup]);

  const startRecording = useCallback(async () => {
    if (state === "recording" || state === "requesting" || state === "transcribing") return;
    setState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        // Stop all mic tracks
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (maxTimerRef.current) {
          clearTimeout(maxTimerRef.current);
          maxTimerRef.current = null;
        }

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        chunksRef.current = [];
        if (blob.size === 0) {
          setState("idle");
          return;
        }

        setState("transcribing");
        try {
          const result = await api.transcribeAudio(blob, keywordsRef.current);
          if (result.text.trim()) {
            onTranscriptRef.current(result.text);
          }
          setState("idle");
        } catch (err) {
          onErrorRef.current(err instanceof Error ? err.message : String(err));
          setState("error");
          setTimeout(() => setState("idle"), 3000);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setState("recording");

      // Auto-stop after max duration
      maxTimerRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === "recording") {
          mediaRecorderRef.current.stop();
        }
      }, MAX_RECORDING_MS);
    } catch (err) {
      cleanup();
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        onErrorRef.current("Microphone permission denied");
      } else if (err instanceof DOMException && err.name === "NotFoundError") {
        onErrorRef.current("No microphone found");
      } else {
        onErrorRef.current(err instanceof Error ? err.message : String(err));
      }
      setState("error");
      setTimeout(() => setState("idle"), 3000);
    }
  }, [state, cleanup]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const cancelRecording = useCallback(() => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.onstop = null;
      if (mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop();
      }
    }
    cleanup();
    setState("idle");
  }, [cleanup]);

  return { state, startRecording, stopRecording, cancelRecording };
}
