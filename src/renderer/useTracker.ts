import { useCallback, useRef, useState } from 'react';
import { chunkScript, type ScriptChunk } from '../nlp/chunk';
import { Matcher, type MatchResult } from '../nlp/matcher';

export interface TrackerState {
  chunks: ScriptChunk[];
  ready: boolean;
  embedding: boolean;
  activeId: number;
  lastMatch: MatchResult | null;
}

export function useTracker() {
  const matcherRef = useRef<Matcher | null>(null);
  const [state, setState] = useState<TrackerState>({
    chunks: [],
    ready: false,
    embedding: false,
    activeId: 0,
    lastMatch: null,
  });

  const loadScript = useCallback(async (text: string) => {
    console.log('[tracker] loadScript text len:', text.length);
    const chunks = chunkScript(text);
    console.log('[tracker] chunked:', chunks.length);
    setState((s) => ({ ...s, chunks, ready: false, embedding: true, activeId: 0 }));
    try {
      const raw = await window.scripter.embedTexts(chunks.map((c) => c.text));
      const embeds = raw.map((arr) => new Float32Array(arr));
      console.log('[tracker] embedded ok, dim:', embeds[0]?.length);
      matcherRef.current = new Matcher(chunks, embeds);
      setState((s) => ({ ...s, ready: true, embedding: false }));
    } catch (e) {
      console.error('[tracker] embed failed:', e);
      setState((s) => ({ ...s, ready: false, embedding: false }));
      throw e;
    }
  }, []);

  const ingest = useCallback(async (transcriptWindow: string) => {
    if (!matcherRef.current || !transcriptWindow.trim()) return null;
    const raw = await window.scripter.embedText(transcriptWindow);
    const e = new Float32Array(raw);
    const r = matcherRef.current.match(e);
    console.log(
      `[match] "${transcriptWindow.slice(-60)}" -> chunk#${r.chunkId} raw=${r.rawScore.toFixed(3)} adj=${r.adjustedScore.toFixed(3)} committed=${r.committed}`
    );
    setState((s) => (s.activeId === r.chunkId ? { ...s, lastMatch: r } : { ...s, activeId: r.chunkId, lastMatch: r }));
    return r;
  }, []);

  const jumpTo = useCallback((id: number) => {
    if (!matcherRef.current) return;
    matcherRef.current.setPosition(id);
    setState((s) => ({ ...s, activeId: id }));
  }, []);

  return { state, loadScript, ingest, jumpTo };
}
