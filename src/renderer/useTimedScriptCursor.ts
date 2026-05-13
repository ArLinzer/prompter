import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { alignTranscriptToScript, type ScriptWord } from '../nlp/scriptAlign';
import type { PlaybackWord } from './useTimedWordQueue';

const RECENT_TIMED_WORDS = 8;
const LOOK_BEHIND = 8;
const LOOK_AHEAD = 30;
const MIN_ALIGN_CONFIDENCE = 0.4;
const ACTIVATE_CONFIDENCE = 0.5;
const ACTIVATE_CONFIRMATIONS = 2;
const MAX_FORWARD_ADVANCE = 4;
const MAX_BACKSTEP = 2;
const LOW_CONFIDENCE_FALLBACK_MS = 3_000;

export interface TimedScriptCursor {
  active: boolean;
  scriptCursorIndex: number;
  chunkId: number;
  localWordIndex: number;
  confidence: number;
  transcript: string;
  playbackWord: PlaybackWord;
}

interface Options {
  fallbackChunkId: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function firstWordIndexForChunk(scriptWords: ScriptWord[], chunkId: number): number {
  return scriptWords.find((word) => word.chunkId === chunkId)?.globalIndex ?? 0;
}

function wordAtCursor(scriptWords: ScriptWord[], cursorIndex: number): ScriptWord | null {
  if (scriptWords.length === 0) return null;
  return scriptWords[clamp(cursorIndex, 0, scriptWords.length - 1)] ?? null;
}

export function useTimedScriptCursor(
  scriptWords: ScriptWord[],
  timedQueueRef: MutableRefObject<PlaybackWord[]>,
  playbackWord: PlaybackWord | null,
  { fallbackChunkId }: Options,
): TimedScriptCursor | null {
  const cursorRef = useRef(0);
  const confirmationRef = useRef(0);
  const lowConfidenceSinceRef = useRef<number | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const [cursor, setCursor] = useState<TimedScriptCursor | null>(null);

  useEffect(() => {
    cursorRef.current = firstWordIndexForChunk(scriptWords, fallbackChunkId);
    confirmationRef.current = 0;
    lowConfidenceSinceRef.current = null;
    if (silenceTimerRef.current != null) window.clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;
    setCursor(null);
  }, [scriptWords]);

  useEffect(() => {
    if (!playbackWord || scriptWords.length === 0) return;

    const queue = timedQueueRef.current;
    const currentQueueIndex = queue.findIndex((word) => word.index === playbackWord.index);
    const recent =
      currentQueueIndex >= 0
        ? queue.slice(Math.max(0, currentQueueIndex - RECENT_TIMED_WORDS + 1), currentQueueIndex + 1)
        : [playbackWord];
    const transcript = recent.map((word) => word.text).join(' ').trim();
    if (!transcript) return;

    const result = alignTranscriptToScript(scriptWords, transcript, {
      cursorIndex: cursorRef.current,
      lookBehind: LOOK_BEHIND,
      lookAhead: LOOK_AHEAD,
      backstepCap: LOOK_BEHIND,
    });

    const matchedIndex = result.matchedScriptIndex ?? result.cursorIndex - 1;
    const rawWord = wordAtCursor(scriptWords, matchedIndex);
    const now = performance.now();

    if (
      !rawWord ||
      result.confidence < MIN_ALIGN_CONFIDENCE ||
      result.matchedContentTokens < 1
    ) {
      confirmationRef.current = 0;
      lowConfidenceSinceRef.current ??= now;
      if (now - lowConfidenceSinceRef.current > LOW_CONFIDENCE_FALLBACK_MS) {
        setCursor(null);
      }
      if (import.meta.env.DEV) {
        console.info(
          `[script-cursor] skip conf=${result.confidence.toFixed(2)} ` +
            `match=${result.matchedContentTokens}/${result.transcriptContentTokens} ` +
            `word="${playbackWord.text}" text=${JSON.stringify(transcript)}`,
        );
      }
      return;
    }

    lowConfidenceSinceRef.current = null;
    confirmationRef.current =
      result.confidence >= ACTIVATE_CONFIDENCE ? confirmationRef.current + 1 : 0;

    const previous = cursorRef.current;
    const cappedIndex =
      rawWord.globalIndex >= previous
        ? Math.min(rawWord.globalIndex, previous + MAX_FORWARD_ADVANCE)
        : Math.max(rawWord.globalIndex, previous - MAX_BACKSTEP);
    cursorRef.current = cappedIndex;

    const scriptWord = wordAtCursor(scriptWords, cappedIndex);
    if (!scriptWord) return;

    const next: TimedScriptCursor = {
      active: confirmationRef.current >= ACTIVATE_CONFIRMATIONS,
      scriptCursorIndex: scriptWord.globalIndex,
      chunkId: scriptWord.chunkId,
      localWordIndex: scriptWord.localIndex,
      confidence: result.confidence,
      transcript,
      playbackWord,
    };
    setCursor(next);

    if (silenceTimerRef.current != null) window.clearTimeout(silenceTimerRef.current);
    const silenceDelayMs = Math.max(
      250,
      playbackWord.absEndMs + LOW_CONFIDENCE_FALLBACK_MS - performance.now(),
    );
    silenceTimerRef.current = window.setTimeout(() => {
      confirmationRef.current = 0;
      setCursor(null);
    }, silenceDelayMs);

    if (import.meta.env.DEV) {
      console.info(
        `[script-cursor] ${next.active ? 'active' : 'warming'} ` +
          `pw=${playbackWord.index}:${JSON.stringify(playbackWord.text)} ` +
          `script=${next.chunkId}:${next.localWordIndex} conf=${result.confidence.toFixed(2)} ` +
          `match=${result.matchedContentTokens}/${result.transcriptContentTokens} ` +
          `confirm=${confirmationRef.current} text=${JSON.stringify(transcript)}`,
      );
    }
  }, [playbackWord?.index, scriptWords, timedQueueRef]);

  useEffect(() => {
    return () => {
      if (silenceTimerRef.current != null) window.clearTimeout(silenceTimerRef.current);
    };
  }, []);

  return cursor;
}
