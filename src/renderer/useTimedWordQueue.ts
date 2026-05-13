import { useCallback, useEffect, useRef, useState } from 'react';
import type { TimedWord } from './useMicCapture';

/**
 * Maintains a time-ordered queue of TimedWords across STT chunks.
 *
 * A small overlap exists between consecutive chunks (CHUNK_SEC vs OVERLAP_SEC
 * in useMicCapture), so the same spoken word can appear in both the tail of
 * one chunk and the head of the next. Drop the duplicate at intake.
 *
 * A rAF loop reports the latest word whose absStartMs <= performance.now()
 * as the "current spoken word". Consumers can read it via the returned
 * `current` state for UI, or `currentRef.current` from another rAF loop.
 *
 * No UI cursor coupling happens here yet — that's Slice 3.
 */

const DEDUPE_TIME_WINDOW_MS = 220;
const DROP_OLDER_THAN_MS = 8_000;
const MAX_QUEUE = 500;

export interface PlaybackWord extends TimedWord {
  /** monotonically increasing across the session */
  index: number;
}

export interface PlaybackState {
  current: PlaybackWord | null;
  upcoming: number;
  total: number;
}

function normalizeText(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function useTimedWordQueue() {
  const queueRef = useRef<PlaybackWord[]>([]);
  const indexRef = useRef(0);
  const currentRef = useRef<PlaybackWord | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastReportedIndexRef = useRef<number | null>(null);

  const [state, setState] = useState<PlaybackState>({ current: null, upcoming: 0, total: 0 });

  const ingest = useCallback((words: TimedWord[]) => {
    if (!words || words.length === 0) return;
    const q = queueRef.current;
    let appended = 0;
    let skipped = 0;

    for (const w of words) {
      const norm = normalizeText(w.text);
      if (!norm) continue;

      // Dedupe: look at the last 3 queue entries within the dedupe time window.
      let isDup = false;
      for (let i = q.length - 1; i >= Math.max(0, q.length - 4); i--) {
        const prev = q[i];
        if (Math.abs(prev.absStartMs - w.absStartMs) > DEDUPE_TIME_WINDOW_MS) continue;
        if (normalizeText(prev.text) === norm) {
          isDup = true;
          break;
        }
      }
      if (isDup) {
        skipped += 1;
        continue;
      }
      const entry: PlaybackWord = { ...w, index: indexRef.current++ };
      // Insert in sorted order by absStartMs; usually appends, but handle the
      // case where overlap delivers a slightly-earlier word.
      if (q.length === 0 || entry.absStartMs >= q[q.length - 1].absStartMs) {
        q.push(entry);
      } else {
        let lo = 0;
        let hi = q.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (q[mid].absStartMs <= entry.absStartMs) lo = mid + 1;
          else hi = mid;
        }
        q.splice(lo, 0, entry);
      }
      appended += 1;
    }

    // Drop ancient entries to bound memory.
    const cutoff = performance.now() - DROP_OLDER_THAN_MS;
    while (q.length > MAX_QUEUE || (q.length > 0 && q[0].absEndMs < cutoff)) {
      q.shift();
    }

    if (appended > 0 || skipped > 0) {
      console.log(`[playback-queue] +${appended} (skipped ${skipped} dup) size=${q.length}`);
    }
  }, []);

  const reset = useCallback(() => {
    queueRef.current = [];
    indexRef.current = 0;
    currentRef.current = null;
    lastReportedIndexRef.current = null;
    setState({ current: null, upcoming: 0, total: 0 });
  }, []);

  // rAF loop: pick the latest word that has already started.
  useEffect(() => {
    const tick = () => {
      const now = performance.now();
      const q = queueRef.current;
      // Linear scan from the end is fine — q is small.
      let cur: PlaybackWord | null = null;
      let upcoming = 0;
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].absStartMs <= now) {
          cur = q[i];
          upcoming = q.length - 1 - i;
          break;
        }
      }
      currentRef.current = cur;

      if (cur && lastReportedIndexRef.current !== cur.index) {
        lastReportedIndexRef.current = cur.index;
        const sincePlanned = Math.round(now - cur.absStartMs);
        console.log(
          `[playback-word] idx=${cur.index} text="${cur.text}" lateMs=${sincePlanned} queue=${q.length}`,
        );
      }

      setState((s) =>
        s.current?.index === cur?.index && s.upcoming === upcoming && s.total === q.length
          ? s
          : { current: cur, upcoming, total: q.length },
      );

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return { state, ingest, reset, currentRef, queueRef };
}
