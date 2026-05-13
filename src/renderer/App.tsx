import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTracker } from './useTracker';
import { useMicCapture } from './useMicCapture';
import { renderPdfPages } from './pdfRender';
import { tokenizeChunk, alignWordCursor, alignChunkPrefix } from '../nlp/wordAlign';

const ROLLING_TOKENS = 16;
const DEFAULT_PREDICT_WPS = 150 / 60; // 150 words per minute → 2.5 words/sec
const MIN_PREDICT_WPS = 1.0;
const MAX_PREDICT_WPS = 4.5;
const STOP_COAST_WPS = 0.5;
const WPS_EMA_ALPHA = 0.3;
const MIN_ANCHOR_MOVES_FOR_WPS = 2;
const SILENCE_COAST_AFTER_MS = 2000;
const MAX_PREDICT_AHEAD = 6; // never predict more than 6 words past the last aligned position
const MAX_ANCHOR_ADVANCE_PER_TRANSCRIPT = 3;
const NEXT_PARAGRAPH_LOCK_WORDS = 3;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function renderWords(text: string, cursor: number): React.ReactNode {
  const words = tokenizeChunk(text);
  if (words.length === 0) return text;
  const out: React.ReactNode[] = [];
  let prevEnd = 0;
  words.forEach((w, idx) => {
    if (w.start > prevEnd) out.push(text.slice(prevEnd, w.start));
    const cls = idx < cursor ? 'word read' : idx === cursor ? 'word current' : 'word';
    out.push(
      <span key={idx} className={cls}>
        {w.text}
      </span>
    );
    prevEnd = w.end;
  });
  if (prevEnd < text.length) out.push(text.slice(prevEnd));
  return out;
}

export function App() {
  const { state, loadScript, ingest, jumpTo } = useTracker();
  const [slides, setSlides] = useState<string[]>([]);
  const [rolling, setRolling] = useState<string>('');
  const [wordCursor, setWordCursor] = useState(0);
  const rollingRef = useRef<string[]>([]);
  const activeRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Predictive word cursor: anchor advances on transcript, rAF interpolates forward.
  const anchorCursorRef = useRef(0);
  const anchorTimeRef = useRef(performance.now());
  const chunkWordCountRef = useRef(0);
  const hasTranscriptAnchorRef = useRef(false);
  const wpsRef = useRef(DEFAULT_PREDICT_WPS);
  const anchorMoveCountRef = useRef(0);
  const lastTranscriptTimeRef = useRef(performance.now());
  const rafRef = useRef<number | null>(null);

  const handleLoadScript = async () => {
    try {
      const r = await window.scripter.loadScript();
      console.log('[app] loadScript IPC returned:', r ? { path: r.path, len: r.text.length } : null);
      if (r) await loadScript(r.text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[app] handleLoadScript failed:', e);
      setError(msg);
    }
  };

  const [slidesLoading, setSlidesLoading] = useState(false);

  const handleLoadSlides = async () => {
    const r = await window.scripter.loadSlides();
    if (r) setSlides(r.images.map((p) => `file://${p}`));
  };

  const handleLoadPdf = async () => {
    const r = await window.scripter.loadPdf();
    if (!r) return;
    setSlidesLoading(true);
    try {
      const pages = await renderPdfPages(r.bytes);
      setSlides(pages);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSlidesLoading(false);
    }
  };

  const onTranscript = useCallback(
    (text: string) => {
      console.log('[transcript]', text);
      lastTranscriptTimeRef.current = performance.now();
      const tokens = text.split(/\s+/).filter(Boolean);
      rollingRef.current = [...rollingRef.current, ...tokens].slice(-ROLLING_TOKENS);
      const window = rollingRef.current.join(' ');
      setRolling(window);
      ingest(window);
    },
    [ingest]
  );

  const mic = useMicCapture({ onTranscript, onError: setError });

  // Reset anchor on paragraph change.
  useEffect(() => {
    const cur = state.chunks[state.activeId];
    const words = cur ? tokenizeChunk(cur.text) : [];
    const seeded = cur ? clamp(alignChunkPrefix(words, rolling), 0, words.length) : 0;
    chunkWordCountRef.current = words.length;
    anchorCursorRef.current = seeded;
    anchorTimeRef.current = performance.now();
    hasTranscriptAnchorRef.current = seeded > 0;
    setWordCursor(seeded);
  }, [state.activeId, state.chunks]);

  // On new transcript: switch promptly if the reader has started the next paragraph,
  // otherwise re-align against the active chunk and advance anchor if it moved.
  useEffect(() => {
    const cur = state.chunks[state.activeId];
    if (!cur) return;
    const words = tokenizeChunk(cur.text);
    chunkWordCountRef.current = words.length;
    const aligned = alignWordCursor(words, rolling);

    const nextChunk = state.chunks[state.activeId + 1];
    if (nextChunk) {
      const nextWords = tokenizeChunk(nextChunk.text);
      const nextPrefix = alignChunkPrefix(nextWords, rolling);
      const currentNearEnd = words.length === 0 || aligned >= Math.max(0, words.length - 2);
      const requiredPrefix = Math.min(NEXT_PARAGRAPH_LOCK_WORDS, nextWords.length);
      if (requiredPrefix > 0 && nextPrefix >= requiredPrefix && (currentNearEnd || nextPrefix > NEXT_PARAGRAPH_LOCK_WORDS)) {
        jumpTo(nextChunk.id);
        return;
      }
    }

    const previousAnchor = anchorCursorRef.current;
    const cappedAligned = Math.min(aligned, previousAnchor + MAX_ANCHOR_ADVANCE_PER_TRANSCRIPT);
    if (cappedAligned > previousAnchor) {
      const now = performance.now();
      const elapsed = (now - anchorTimeRef.current) / 1000;
      if (hasTranscriptAnchorRef.current && elapsed > 0.2) {
        const sampleWps = clamp((cappedAligned - previousAnchor) / elapsed, MIN_PREDICT_WPS, MAX_PREDICT_WPS);
        wpsRef.current = WPS_EMA_ALPHA * sampleWps + (1 - WPS_EMA_ALPHA) * wpsRef.current;
        anchorMoveCountRef.current += 1;
      }
      anchorCursorRef.current = cappedAligned;
      anchorTimeRef.current = now;
      hasTranscriptAnchorRef.current = true;
    }
  }, [jumpTo, rolling, state.activeId, state.chunks]);

  // rAF loop: render cursor = anchor + elapsed * WPS, clamped.
  useEffect(() => {
    if (!mic.state.listening) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }

    const tick = () => {
      if (!hasTranscriptAnchorRef.current) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const now = performance.now();
      const elapsed = (now - anchorTimeRef.current) / 1000;
      const silenceMs = now - lastTranscriptTimeRef.current;
      const trustedWps = anchorMoveCountRef.current >= MIN_ANCHOR_MOVES_FOR_WPS ? wpsRef.current : DEFAULT_PREDICT_WPS;
      const coastFactor = silenceMs > SILENCE_COAST_AFTER_MS
        ? Math.max(0, 1 - (silenceMs - SILENCE_COAST_AFTER_MS) / SILENCE_COAST_AFTER_MS)
        : 1;
      const predictWps = Math.max(STOP_COAST_WPS, trustedWps * coastFactor);
      const predicted = Math.floor(anchorCursorRef.current + elapsed * predictWps);
      const cap = Math.min(
        chunkWordCountRef.current,
        anchorCursorRef.current + MAX_PREDICT_AHEAD
      );
      const next = Math.max(0, Math.min(predicted, cap));
      setWordCursor((prev) => (prev === next ? prev : next));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [mic.state.listening]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [state.activeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') jumpTo(Math.min(state.activeId + 1, state.chunks.length - 1));
      else if (e.key === 'ArrowUp') jumpTo(Math.max(state.activeId - 1, 0));
      else if (e.key === ' ') {
        e.preventDefault();
        mic.state.listening ? mic.stop() : mic.start();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [jumpTo, state.activeId, state.chunks.length, mic]);

  const activeSlide = state.chunks[state.activeId]?.slide;
  const slideSrc = activeSlide && slides[activeSlide - 1] ? slides[activeSlide - 1] : null;

  const sttStatus = !mic.state.ready
    ? mic.state.initError
      ? `STT init error: ${mic.state.initError}`
      : `loading whisper (${mic.state.modelName || 'base.en'})…`
    : `whisper ${mic.state.modelName} ready${mic.state.lastLatencyMs ? ` · ${mic.state.lastLatencyMs}ms/chunk` : ''}`;

  return (
    <div className="app">
      <div className="toolbar">
        <button onClick={handleLoadScript}>Load script</button>
        <button onClick={handleLoadPdf} disabled={slidesLoading}>{slidesLoading ? 'Rendering PDF…' : 'Load PDF'}</button>
        <button onClick={handleLoadSlides}>Load image folder</button>
        {!mic.state.listening ? (
          <button className="primary" onClick={mic.start} disabled={!state.ready || !mic.state.ready}>
            Start tracking
          </button>
        ) : (
          <button onClick={mic.stop}>Stop</button>
        )}
        <div className="spacer" />
        <div className="status">
          {sttStatus}
          {state.ready && ` · chunk#${state.activeId} · slide ${activeSlide ?? '-'}`}
          {state.lastMatch && state.ready && ` · sim=${state.lastMatch.rawScore.toFixed(2)}`}
        </div>
      </div>

      <div className="main">
        <div className="pane">
          <div className="pane-header">Script ({state.chunks.length} chunks)</div>
          <div className="script">
            {state.chunks.length === 0 && <div style={{ color: 'var(--muted)' }}>No script loaded. Click "Load script".</div>}
            {state.chunks.map((c) => {
              const cls =
                c.id === state.activeId
                  ? 'active'
                  : c.id < state.activeId
                    ? 'past'
                    : '';
              const isActive = c.id === state.activeId;
              return (
                <div
                  key={c.id}
                  ref={isActive ? activeRef : null}
                  className={`chunk ${cls}`}
                  onClick={() => jumpTo(c.id)}
                >
                  {c.slide != null && <span style={{ opacity: 0.5, fontSize: '0.7em' }}>[slide {c.slide}] </span>}
                  {isActive ? renderWords(c.text, wordCursor) : c.text}
                </div>
              );
            })}
          </div>
        </div>

        <div className="pane">
          <div className="pane-header">Slide {activeSlide ?? '-'}</div>
          <div className="slides">
            {slideSrc ? <img src={slideSrc} alt={`slide ${activeSlide}`} /> : <div style={{ color: 'var(--muted)' }}>No slides loaded</div>}
          </div>
        </div>
      </div>

      <div className="transcript">
        {mic.state.listening ? '🎙 ' : '○ '}
        {error ? `⚠ ${error}` : rolling || 'idle — press Space or click Start tracking'}
      </div>
    </div>
  );
}
