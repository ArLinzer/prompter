import { useCallback, useEffect, useRef, useState } from 'react';
import { WORKLET_SOURCE } from './audio-worklet';

const TARGET_RATE = 16000;
const CHUNK_SEC = 1.5;
const OVERLAP_SEC = 0.3;

interface Options {
  onTranscript: (text: string) => void;
  onError?: (msg: string) => void;
}

interface CaptureState {
  listening: boolean;
  initError: string | null;
  ready: boolean;
  modelName: string;
  lastLatencyMs: number | null;
}

export function useMicCapture({ onTranscript, onError }: Options) {
  const [state, setState] = useState<CaptureState>({
    listening: false,
    initError: null,
    ready: false,
    modelName: '',
    lastLatencyMs: null,
  });

  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const bufRef = useRef<Float32Array[]>([]);
  const bufSamplesRef = useRef(0);
  const sampleRateRef = useRef(48000);
  const busyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await window.scripter.sttInit();
      if (cancelled) return;
      setState((s) => ({ ...s, ready: r.ready, modelName: r.model, initError: r.error ?? null }));
      if (!r.ready) onError?.(r.error ?? 'STT init failed');
    })();
    return () => {
      cancelled = true;
    };
  }, [onError]);

  const flushChunk = useCallback(async () => {
    if (busyRef.current) return;
    const chunkSamples = Math.floor(CHUNK_SEC * sampleRateRef.current);
    const overlapSamples = Math.floor(OVERLAP_SEC * sampleRateRef.current);
    if (bufSamplesRef.current < chunkSamples) return;

    const total = bufSamplesRef.current;
    const combined = new Float32Array(total);
    let off = 0;
    for (const part of bufRef.current) {
      combined.set(part, off);
      off += part.length;
    }

    const chunk = combined.subarray(0, chunkSamples);
    const tail = combined.subarray(chunkSamples - overlapSamples);
    bufRef.current = [new Float32Array(tail)];
    bufSamplesRef.current = tail.length;

    const downsampled = resampleTo16k(chunk, sampleRateRef.current);
    const pcm = floatToPCM16(downsampled);

    busyRef.current = true;
    try {
      const r = await window.scripter.sttTranscribe(pcm.buffer as ArrayBuffer, TARGET_RATE);
      setState((s) => ({ ...s, lastLatencyMs: r.durationMs }));
      if (r.text) onTranscript(r.text);
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
    }
  }, [onTranscript, onError]);

  const start = useCallback(async () => {
    if (!state.ready) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const ctx = new AudioContext();
      sampleRateRef.current = ctx.sampleRate;
      ctxRef.current = ctx;

      const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'capture-processor');
      node.port.onmessage = (e) => {
        const samples = e.data as Float32Array;
        bufRef.current.push(samples);
        bufSamplesRef.current += samples.length;
        flushChunk();
      };
      src.connect(node);
      nodeRef.current = node;

      setState((s) => ({ ...s, listening: true }));
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e));
    }
  }, [state.ready, flushChunk, onError]);

  const stop = useCallback(() => {
    nodeRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current?.close();
    nodeRef.current = null;
    streamRef.current = null;
    ctxRef.current = null;
    bufRef.current = [];
    bufSamplesRef.current = 0;
    setState((s) => ({ ...s, listening: false }));
  }, []);

  return { state, start, stop };
}

function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_RATE) return input;
  const ratio = fromRate / TARGET_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIdx - lo;
    out[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return out;
}

function floatToPCM16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
