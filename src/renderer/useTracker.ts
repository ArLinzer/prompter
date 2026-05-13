import { useCallback, useEffect, useRef, useState } from 'react';
import { chunkScript, type ScriptChunk } from '../nlp/chunk';
import { embed, embedBatch } from '../nlp/embed';
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
    const chunks = chunkScript(text);
    setState((s) => ({ ...s, chunks, ready: false, embedding: true, activeId: 0 }));
    const embeds = await embedBatch(chunks.map((c) => c.text));
    matcherRef.current = new Matcher(chunks, embeds);
    setState((s) => ({ ...s, ready: true, embedding: false }));
  }, []);

  const ingest = useCallback(async (transcriptWindow: string) => {
    if (!matcherRef.current || !transcriptWindow.trim()) return null;
    const e = await embed(transcriptWindow);
    const r = matcherRef.current.match(e);
    if (r.committed) setState((s) => ({ ...s, activeId: r.chunkId, lastMatch: r }));
    else setState((s) => ({ ...s, lastMatch: r }));
    return r;
  }, []);

  const jumpTo = useCallback((id: number) => {
    if (!matcherRef.current) return;
    matcherRef.current.setPosition(id);
    setState((s) => ({ ...s, activeId: id }));
  }, []);

  return { state, loadScript, ingest, jumpTo };
}
