import { app } from 'electron';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WaveFile } from 'wavefile';
import { nodewhisper } from 'nodejs-whisper';
import type { SttInitResult, SttTranscribeResult } from '../shared/ipc';

const MODEL = (process.env.SCRIPTER_WHISPER_MODEL ?? 'base.en') as
  | 'tiny.en'
  | 'base.en'
  | 'small.en';

let initialized = false;
let initPromise: Promise<SttInitResult> | null = null;

function tmpDir(): string {
  const d = join(app.getPath('userData'), 'stt-tmp');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

export function initStt(): Promise<SttInitResult> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      // Force model download by transcribing a tiny silence WAV.
      const wav = new WaveFile();
      const silent = new Int16Array(16000);
      wav.fromScratch(1, 16000, '16', silent);
      const path = join(tmpDir(), 'warmup.wav');
      writeFileSync(path, wav.toBuffer());
      await nodewhisper(path, {
        modelName: MODEL,
        autoDownloadModelName: MODEL,
        removeWavFileAfterTranscription: true,
        withCuda: false,
        whisperOptions: { outputInText: false, outputInVtt: false, outputInSrt: false, outputInCsv: false, translateToEnglish: false, wordTimestamps: false, timestamps_length: 0, splitOnWord: false },
      } as any);
      initialized = true;
      return { ready: true, model: MODEL };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error('[stt] init failed', error);
      return { ready: false, model: MODEL, error };
    }
  })();
  return initPromise;
}

export async function transcribe(pcm16: Int16Array, sampleRate: number): Promise<SttTranscribeResult> {
  if (!initialized) {
    const r = await initStt();
    if (!r.ready) throw new Error(r.error ?? 'stt not initialized');
  }

  const t0 = Date.now();
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRate, '16', pcm16);
  const wavBuf = wav.toBuffer();

  const path = join(tmpDir(), `${randomUUID()}.wav`);
  writeFileSync(path, wavBuf);

  try {
    const out = await nodewhisper(path, {
      modelName: MODEL,
      autoDownloadModelName: MODEL,
      removeWavFileAfterTranscription: false,
      withCuda: false,
      logger: { log: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: console.error } as any,
      whisperOptions: {
        outputInText: false,
        outputInVtt: false,
        outputInSrt: false,
        outputInCsv: false,
        translateToEnglish: false,
        wordTimestamps: false,
        timestamps_length: 0,
        splitOnWord: false,
      },
    } as any);
    const text = typeof out === 'string' ? cleanWhisperOutput(out) : '';
    return { text, durationMs: Date.now() - t0 };
  } finally {
    try { rmSync(path); } catch {}
  }
}

function cleanWhisperOutput(raw: string): string {
  // nodejs-whisper returns lines like "[00:00:00.000 --> 00:00:02.000]  text"
  return raw
    .split('\n')
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}
