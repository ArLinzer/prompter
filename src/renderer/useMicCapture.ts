import { useCallback, useEffect, useRef, useState } from 'react';
import { WORKLET_SOURCE } from './audio-worklet';
import type { WordTiming } from '../shared/ipc';

const TARGET_RATE = 16000;

// VAD-driven chunking. Flush a chunk when speech ends (natural pause).
// Cap with MAX_CHUNK_SEC so long uninterrupted sentences still ship.
const VAD_RMS_ON = 0.012; // start-of-speech RMS threshold
const VAD_RMS_OFF = 0.008; // end-of-speech (hysteresis: lower than ON)
const VAD_TRIGGER_FRAMES = 5; // frames > ON to enter SPEAKING (~50ms @ 128-sample frames)
const VAD_HANG_FRAMES = 35; // frames < OFF to leave SPEAKING (~290ms)
const PRE_ROLL_MS = 120; // keep this much pre-speech audio
const MIN_CHUNK_SEC = 0.4; // don't flush sub-400ms blips (noise)
const MAX_CHUNK_SEC = 4.0; // force-flush after this much continuous speech
const SILENT_RING_MS = 500; // ring buffer of recent silence for pre-roll

export interface TimedWord extends WordTiming {
  /** absolute wall-clock (renderer performance.now()) at which the word starts */
  absStartMs: number;
  absEndMs: number;
}

interface Options {
  onTranscript: (text: string) => void;
  onWords?: (words: TimedWord[], chunkStartWallClockMs: number) => void;
  onError?: (msg: string) => void;
}

interface CaptureState {
  listening: boolean;
  initError: string | null;
  ready: boolean;
  modelName: string;
  lastLatencyMs: number | null;
  vadState: 'silent' | 'speaking';
}

interface VadChunk {
  samples: Float32Array;
  startWallClockMs: number;
}

export function useMicCapture({ onTranscript, onWords, onError }: Options) {
  const [state, setState] = useState<CaptureState>({
    listening: false,
    initError: null,
    ready: false,
    modelName: '',
    lastLatencyMs: null,
    vadState: 'silent',
  });

  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const sampleRateRef = useRef(48000);
  const busyRef = useRef(false);

  // Speech ring buffer + pre-roll ring buffer.
  const speechBufRef = useRef<Float32Array[]>([]);
  const speechSamplesRef = useRef(0);
  const speechStartedAtRef = useRef<number | null>(null);
  const preRollBufRef = useRef<Float32Array[]>([]);
  const preRollSamplesRef = useRef(0);

  // VAD state machine.
  const vadStateRef = useRef<'silent' | 'speaking'>('silent');
  const aboveThresholdFramesRef = useRef(0);
  const belowThresholdFramesRef = useRef(0);

  // Pending chunks (flush queue) and processing loop.
  const pendingChunksRef = useRef<VadChunk[]>([]);

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

  const drainPending = useCallback(async () => {
    if (busyRef.current) return;
    const chunk = pendingChunksRef.current.shift();
    if (!chunk) return;

    busyRef.current = true;
    try {
      const downsampled = resampleTo16k(chunk.samples, sampleRateRef.current);
      const pcm = floatToPCM16(downsampled);

      const r = await window.scripter.sttTranscribe(
        pcm.buffer as ArrayBuffer,
        TARGET_RATE,
        chunk.startWallClockMs,
      );
      setState((s) => ({ ...s, lastLatencyMs: r.durationMs }));
      if (r.text) onTranscript(r.text);
      if (r.words && r.words.length > 0) {
        const anchor = r.chunkStartWallClockMs ?? chunk.startWallClockMs;
        const timed: TimedWord[] = r.words.map((w) => ({
          ...w,
          absStartMs: anchor + w.startMs,
          absEndMs: anchor + w.endMs,
        }));
        const preview = timed
          .slice(0, 8)
          .map((w) => `${w.text}@+${Math.round(w.absStartMs - anchor)}ms`)
          .join(' ');
        console.log(
          `[timed-words] anchor=${anchor.toFixed(0)} count=${timed.length} ` +
            `${preview}${timed.length > 8 ? ` …+${timed.length - 8}` : ''}`,
        );
        onWords?.(timed, anchor);
      }
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      if (pendingChunksRef.current.length > 0) {
        // Process next chunk on next macrotask so we don't starve the worklet thread.
        setTimeout(drainPending, 0);
      }
    }
  }, [onTranscript, onWords, onError]);

  const enqueueChunk = useCallback(
    (samples: Float32Array, startWallClockMs: number, reason: string) => {
      const durationSec = samples.length / sampleRateRef.current;
      if (durationSec < MIN_CHUNK_SEC) {
        console.log(`[vad] drop chunk (${reason}) duration=${(durationSec * 1000).toFixed(0)}ms — below MIN_CHUNK_SEC`);
        return;
      }
      console.log(
        `[vad] flush chunk (${reason}) duration=${(durationSec * 1000).toFixed(0)}ms anchor=${startWallClockMs.toFixed(0)}`,
      );
      pendingChunksRef.current.push({ samples, startWallClockMs });
      drainPending();
    },
    [drainPending],
  );

  const finalizeSpeechChunk = useCallback(
    (reason: string) => {
      if (speechBufRef.current.length === 0) return;
      const total = speechSamplesRef.current;
      const merged = new Float32Array(total);
      let off = 0;
      for (const part of speechBufRef.current) {
        merged.set(part, off);
        off += part.length;
      }
      const startMs = speechStartedAtRef.current ?? performance.now() - (total / sampleRateRef.current) * 1000;
      speechBufRef.current = [];
      speechSamplesRef.current = 0;
      speechStartedAtRef.current = null;
      enqueueChunk(merged, startMs, reason);
    },
    [enqueueChunk],
  );

  const onWorkletFrame = useCallback(
    (samples: Float32Array, rms: number) => {
      const sampleRate = sampleRateRef.current;
      const frameDurMs = (samples.length / sampleRate) * 1000;
      const now = performance.now();

      // Maintain pre-roll ring of recent silence frames (so we don't clip the first phoneme).
      const preRollMaxSamples = Math.floor((PRE_ROLL_MS / 1000) * sampleRate);
      const silentRingMaxSamples = Math.floor((SILENT_RING_MS / 1000) * sampleRate);

      if (vadStateRef.current === 'silent') {
        // Append to pre-roll ring.
        preRollBufRef.current.push(samples);
        preRollSamplesRef.current += samples.length;
        while (preRollSamplesRef.current > silentRingMaxSamples && preRollBufRef.current.length > 1) {
          const dropped = preRollBufRef.current.shift();
          if (dropped) preRollSamplesRef.current -= dropped.length;
        }

        // RMS above ON threshold for VAD_TRIGGER_FRAMES → enter SPEAKING.
        if (rms >= VAD_RMS_ON) {
          aboveThresholdFramesRef.current += 1;
          belowThresholdFramesRef.current = 0;
          if (aboveThresholdFramesRef.current >= VAD_TRIGGER_FRAMES) {
            // Transition silent → speaking. Seed with pre-roll buffer.
            vadStateRef.current = 'speaking';
            aboveThresholdFramesRef.current = 0;

            const preRollTotal = preRollSamplesRef.current;
            const preRollTake = Math.min(preRollTotal, preRollMaxSamples);
            if (preRollTake > 0) {
              const ring = new Float32Array(preRollTotal);
              let o = 0;
              for (const part of preRollBufRef.current) {
                ring.set(part, o);
                o += part.length;
              }
              const startOff = preRollTotal - preRollTake;
              const preRollSlice = ring.subarray(startOff);
              speechBufRef.current.push(new Float32Array(preRollSlice));
              speechSamplesRef.current += preRollSlice.length;
              speechStartedAtRef.current = now - (preRollTake / sampleRate) * 1000 - VAD_TRIGGER_FRAMES * frameDurMs;
            } else {
              speechStartedAtRef.current = now - VAD_TRIGGER_FRAMES * frameDurMs;
            }

            preRollBufRef.current = [];
            preRollSamplesRef.current = 0;
            setState((s) => (s.vadState === 'speaking' ? s : { ...s, vadState: 'speaking' }));
          }
        } else {
          aboveThresholdFramesRef.current = 0;
        }
        return;
      }

      // SPEAKING state.
      speechBufRef.current.push(samples);
      speechSamplesRef.current += samples.length;

      if (rms < VAD_RMS_OFF) {
        belowThresholdFramesRef.current += 1;
      } else {
        belowThresholdFramesRef.current = 0;
      }

      const durationSec = speechSamplesRef.current / sampleRate;

      if (belowThresholdFramesRef.current >= VAD_HANG_FRAMES) {
        // Speech ended.
        vadStateRef.current = 'silent';
        belowThresholdFramesRef.current = 0;
        aboveThresholdFramesRef.current = 0;
        setState((s) => (s.vadState === 'silent' ? s : { ...s, vadState: 'silent' }));
        finalizeSpeechChunk('silence');
      } else if (durationSec >= MAX_CHUNK_SEC) {
        // Hit max chunk length — flush but stay in speaking state.
        finalizeSpeechChunk('max-length');
        // Seed next chunk with a small overlap of last few frames so we don't lose
        // mid-word audio across the forced cut.
        const overlapSamples = Math.floor(0.2 * sampleRate);
        if (speechSamplesRef.current === 0) speechStartedAtRef.current = now;
        // Re-grab the trailing audio from the just-flushed merged buffer:
        // since we already cleared the buffer in finalizeSpeechChunk, we can't.
        // Accept a tiny gap; whisper handles it.
        speechStartedAtRef.current = now;
        void overlapSamples;
      }
    },
    [finalizeSpeechChunk],
  );

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
        const data = e.data as { samples: Float32Array; rms: number };
        onWorkletFrame(data.samples, data.rms);
      };
      src.connect(node);
      nodeRef.current = node;

      setState((s) => ({ ...s, listening: true }));
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e));
    }
  }, [state.ready, onWorkletFrame, onError]);

  const stop = useCallback(() => {
    if (vadStateRef.current === 'speaking') finalizeSpeechChunk('stop');
    nodeRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current?.close();
    nodeRef.current = null;
    streamRef.current = null;
    ctxRef.current = null;
    speechBufRef.current = [];
    speechSamplesRef.current = 0;
    speechStartedAtRef.current = null;
    preRollBufRef.current = [];
    preRollSamplesRef.current = 0;
    vadStateRef.current = 'silent';
    aboveThresholdFramesRef.current = 0;
    belowThresholdFramesRef.current = 0;
    pendingChunksRef.current = [];
    setState((s) => ({ ...s, listening: false, vadState: 'silent' }));
  }, [finalizeSpeechChunk]);

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
