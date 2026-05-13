import { app } from 'electron';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { WaveFile } from 'wavefile';
import { nodewhisper } from 'nodejs-whisper';
import shell from 'shelljs';
import type { SttInitResult, SttTranscribeResult, WordTiming } from '../shared/ipc';

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

export async function transcribe(
  pcm16: Int16Array,
  sampleRate: number,
  chunkStartWallClockMs?: number,
): Promise<SttTranscribeResult> {
  if (!initialized) {
    const r = await initStt();
    if (!r.ready) throw new Error(r.error ?? 'stt not initialized');
  }

  const t0 = Date.now();

  const rms = rmsLevel(pcm16);
  if (rms < SILENCE_RMS_THRESHOLD) {
    return { text: '', durationMs: Date.now() - t0, words: [], chunkStartWallClockMs };
  }
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRate, '16', pcm16);
  const wavBuf = wav.toBuffer();

  const path = join(tmpDir(), `${randomUUID()}.wav`);
  writeFileSync(path, wavBuf);
  const jsonPath = `${path}.json`;

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
        outputInJson: true,
        outputInJsonFull: true,
        translateToEnglish: false,
        wordTimestamps: true,
        timestamps_length: 1,
        splitOnWord: true,
      },
    } as any);
    const text = typeof out === 'string' ? cleanWhisperOutput(out) : '';
    const words = readWordTimings(jsonPath);
    const durationMs = Date.now() - t0;
    if (text) {
      console.log(
        `[stt] ${durationMs}ms rms=${rms.toFixed(3)} text=${JSON.stringify(text)} words=${words.length}`,
      );
    }
    if (words.length > 0) {
      const preview = words
        .slice(0, 8)
        .map((w) => `${w.text}@${w.startMs}-${w.endMs}ms`)
        .join(' ');
      console.log(`[stt-words] ${preview}${words.length > 8 ? ` …+${words.length - 8}` : ''}`);
    }
    return { text, durationMs, words, chunkStartWallClockMs };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // nodejs-whisper throws "Transcription failed or produced no output" for silence — treat as empty.
    if (/no output|failed or produced/i.test(msg)) {
      return { text: '', durationMs: Date.now() - t0, words: [], chunkStartWallClockMs };
    }
    console.error('[stt] transcribe error:', msg);
    throw e;
  } finally {
    try { rmSync(path); } catch {}
    try { rmSync(jsonPath); } catch {}
  }
}

interface WhisperJsonSegment {
  text?: string;
  offsets?: { from?: number; to?: number };
  timestamps?: { from?: string; to?: string };
  tokens?: Array<{
    text?: string;
    offsets?: { from?: number; to?: number };
    timestamps?: { from?: string; to?: string };
  }>;
}

interface WhisperJsonFile {
  transcription?: WhisperJsonSegment[];
  segments?: WhisperJsonSegment[];
}

function readWordTimings(jsonPath: string): WordTiming[] {
  if (!existsSync(jsonPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(jsonPath, 'utf-8');
  } catch {
    return [];
  }
  let parsed: WhisperJsonFile;
  try {
    parsed = JSON.parse(raw) as WhisperJsonFile;
  } catch {
    return [];
  }
  const segments = parsed.transcription ?? parsed.segments ?? [];
  if (!Array.isArray(segments)) return [];

  const out: WordTiming[] = [];
  const NOISE_MARKER = /\[(blank_audio|music|noise|silence|inaudible|laughter|applause)\]/i;
  const SILENT_BRACKET_FRAGMENT = /^(\[|\]|_|bl|ank|aud|io|mus|ic|noise|silen|ce|inaud|laugh|appl|ause)$/i;
  const SPECIAL_TOKEN = /^[_<\[]([A-Z_]+)[_>\]]$|^_BEG_$|^_TT_\d+$|^<\|.*\|>$/;

  for (const seg of segments) {
    const segText = (seg.text ?? '').trim();
    const segStartMs = seg.offsets?.from ?? parseTimestampMs(seg.timestamps?.from);
    const segEndMs = seg.offsets?.to ?? parseTimestampMs(seg.timestamps?.to);

    if (segText) {
      // With wordTimestamps + splitOnWord, each segment is already one word.
      // Push as-is; do NOT merge — merging fused whole words like "Welcome" + "everyone".
      if (NOISE_MARKER.test(segText)) continue;
      if (SPECIAL_TOKEN.test(segText)) continue;
      const cleaned = stripPunctEdges(segText);
      if (!cleaned) continue;
      if (!hasAlphaNumeric(cleaned)) continue;
      if (SILENT_BRACKET_FRAGMENT.test(cleaned)) continue;
      if (segStartMs == null || segEndMs == null) continue;
      out.push({ text: cleaned, startMs: segStartMs, endMs: segEndMs });
      continue;
    }

    // Token-level fallback only when segment.text was missing.
    // BPE pieces here legitimately need merging.
    const segTokens: WordTiming[] = [];
    for (const tok of seg.tokens ?? []) {
      const raw = (tok.text ?? '').trim();
      if (!raw) continue;
      if (NOISE_MARKER.test(raw)) continue;
      if (SPECIAL_TOKEN.test(raw)) continue;
      const cleaned = stripPunctEdges(raw);
      if (!cleaned || !hasAlphaNumeric(cleaned)) continue;
      if (SILENT_BRACKET_FRAGMENT.test(cleaned)) continue;
      const startMs = tok.offsets?.from ?? parseTimestampMs(tok.timestamps?.from) ?? segStartMs;
      const endMs = tok.offsets?.to ?? parseTimestampMs(tok.timestamps?.to) ?? segEndMs;
      if (startMs == null || endMs == null) continue;
      // BPE convention in whisper: continuation tokens have no leading space in tok.text.
      const isContinuation = !/^\s/.test(tok.text ?? '');
      segTokens.push({ text: cleaned, startMs, endMs });
      const prev = segTokens[segTokens.length - 2];
      if (prev && isContinuation && segTokens.length >= 2) {
        prev.text = prev.text + cleaned;
        prev.endMs = endMs;
        segTokens.pop();
      }
    }
    for (const t of segTokens) out.push(t);
  }

  return out;
}

function stripPunctEdges(text: string): string {
  return text.replace(/^[\s.,!?;:"'()\[\]‘’“”-]+|[\s.,!?;:"'()\[\]‘’“”-]+$/g, '');
}

function hasAlphaNumeric(text: string): boolean {
  return /[a-zA-Z0-9]/.test(text);
}


function parseTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  // whisper.cpp emits "HH:MM:SS,mmm"
  const m = value.match(/^(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return (
    parseInt(h, 10) * 3_600_000 +
    parseInt(mm, 10) * 60_000 +
    parseInt(ss, 10) * 1000 +
    parseInt(ms.padEnd(3, '0'), 10)
  );
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
