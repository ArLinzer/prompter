import { app } from 'electron';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { WaveFile } from 'wavefile';
import { nodewhisper } from 'nodejs-whisper';
import shell from 'shelljs';
import type { SttInitResult, SttTranscribeResult } from '../shared/ipc';

function resolveNodeBinary(): string {
  const cmd = process.platform === 'win32' ? 'where node' : 'which node';
  try {
    const out = execSync(cmd, { encoding: 'utf-8' }).split(/\r?\n/)[0].trim();
    if (out) return out;
  } catch {}
  return process.platform === 'win32' ? 'node.exe' : '/usr/local/bin/node';
}

shell.config.execPath = resolveNodeBinary();

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

const SILENCE_RMS_THRESHOLD = 0.01;

export async function transcribe(pcm16: Int16Array, sampleRate: number): Promise<SttTranscribeResult> {
  if (!initialized) {
    const r = await initStt();
    if (!r.ready) throw new Error(r.error ?? 'stt not initialized');
  }

  const t0 = Date.now();

  const rms = rmsLevel(pcm16);
  if (rms < SILENCE_RMS_THRESHOLD) {
    return { text: '', durationMs: Date.now() - t0 };
  }
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
    const durationMs = Date.now() - t0;
    if (text) console.log(`[stt] ${durationMs}ms rms=${rms.toFixed(3)} text=${JSON.stringify(text)}`);
    return { text, durationMs };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // nodejs-whisper throws "Transcription failed or produced no output" for silence — treat as empty.
    if (/no output|failed or produced/i.test(msg)) {
      return { text: '', durationMs: Date.now() - t0 };
    }
    console.error('[stt] transcribe error:', msg);
    throw e;
  } finally {
    try { rmSync(path); } catch {}
  }
}

function rmsLevel(pcm: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length) / 32768;
}

function cleanWhisperOutput(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .map((line) => line.replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE|inaudible|laughter|applause)\]/gi, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}
