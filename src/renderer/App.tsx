import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTracker } from './useTracker';
import { useMicCapture } from './useMicCapture';
import { renderPdfPages } from './pdfRender';
import { tokenizeChunk, alignWordCursor } from '../nlp/wordAlign';

const ROLLING_TOKENS = 16;

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
      const tokens = text.split(/\s+/).filter(Boolean);
      rollingRef.current = [...rollingRef.current, ...tokens].slice(-ROLLING_TOKENS);
      const window = rollingRef.current.join(' ');
      setRolling(window);
      ingest(window);
    },
    [ingest]
  );

  useEffect(() => {
    setWordCursor(0);
  }, [state.activeId]);

  useEffect(() => {
    const cur = state.chunks[state.activeId];
    if (!cur) return;
    const words = tokenizeChunk(cur.text);
    const c = alignWordCursor(words, rolling);
    if (c > wordCursor) setWordCursor(c);
  }, [rolling, state.activeId, state.chunks, wordCursor]);

  const mic = useMicCapture({ onTranscript, onError: setError });

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
                  : c.id === state.activeId + 1
                    ? 'next'
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
