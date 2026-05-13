import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTracker } from './useTracker';
import { useMicCapture, type TimedWord } from './useMicCapture';
import { renderPdfPages } from './pdfRender';
import { tokenizeChunk, alignWordCursor, alignChunkPrefix } from '../nlp/wordAlign';
import {
  alignTranscriptToScript,
  tokenizeScriptChunks,
  type ScriptAlignResult,
  type ScriptWord,
} from '../nlp/scriptAlign';
import { useTimedWordQueue } from './useTimedWordQueue';
import { useTimedScriptCursor } from './useTimedScriptCursor';

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
const SCRIPT_ALIGN_DISPLAY_CONFIDENCE = 0.58;
const SCRIPT_ALIGN_SWITCH_CONFIDENCE = 0.64;
const SCRIPT_ALIGN_SWITCH_CONFIRMATIONS = 2;
const SCRIPT_ALIGN_MAX_WORD_ADVANCE = 3;
const SCRIPT_ALIGN_MAX_WORD_BACKSTEP = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function renderWords(text: string, cursor: number, options: { currentClass?: string; showRead?: boolean } = {}): React.ReactNode {
  const currentClass = options.currentClass ?? 'current';
  const showRead = options.showRead ?? true;
  const words = tokenizeChunk(text);
  if (words.length === 0) return text;
  const out: React.ReactNode[] = [];
  let prevEnd = 0;
  words.forEach((w, idx) => {
    if (w.start > prevEnd) out.push(text.slice(prevEnd, w.start));
    const cls = idx === cursor ? `word ${currentClass}` : showRead && idx < cursor ? 'word read' : 'word';
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

interface ScriptAlignDebug {
  result: ScriptAlignResult;
  chunkId: number | null;
  localIndex: number | null;
  wordText: string | null;
}

interface StableScriptAlign {
  chunkId: number;
  localIndex: number;
  confidence: number;
}

export function App() {
  const { state, loadScript, ingest, jumpTo } = useTracker();
  const [slides, setSlides] = useState<string[]>([]);
  const [rolling, setRolling] = useState<string>('');
  const [wordCursor, setWordCursor] = useState(0);
  const [scriptAlignDebug, setScriptAlignDebug] = useState<ScriptAlignDebug | null>(null);
  const [stableScriptAlign, setStableScriptAlign] = useState<StableScriptAlign | null>(null);
  const rollingRef = useRef<string[]>([]);
  const activeRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scriptWordsRef = useRef<ScriptWord[]>([]);
  const scriptAlignCursorRef = useRef(0);
  const stableScriptAlignRef = useRef<StableScriptAlign | null>(null);
  const scriptAlignCandidateRef = useRef<{ chunkId: number; count: number } | null>(null);
  const scriptAlignLowConfidenceRef = useRef(0);

  // Predictive word cursor: anchor advances on transcript, rAF interpolates forward.
  const anchorCursorRef = useRef(0);
  const anchorTimeRef = useRef(performance.now());
  const chunkWordCountRef = useRef(0);
  const hasTranscriptAnchorRef = useRef(false);
  const wpsRef = useRef(DEFAULT_PREDICT_WPS);
  const anchorMoveCountRef = useRef(0);
  const lastTranscriptTimeRef = useRef(performance.now());
  const rafRef = useRef<number | null>(null);
  const wordCursorRef = useRef(0);

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

  const {
    state: timedWordState,
    ingest: ingestTimedWords,
    reset: resetTimedWords,
    queueRef: timedWordQueueRef,
  } =
    useTimedWordQueue();

  const onWords = useCallback(
    (words: TimedWord[]) => {
      ingestTimedWords(words);
    },
    [ingestTimedWords],
  );

  const mic = useMicCapture({ onTranscript, onWords, onError: setError });
  const scriptWords = useMemo(() => tokenizeScriptChunks(state.chunks), [state.chunks]);

  // Reset queue when a new script is loaded.
  useEffect(() => {
    resetTimedWords();
  }, [state.chunks, resetTimedWords]);

  useEffect(() => {
    scriptWordsRef.current = scriptWords;
    scriptAlignCursorRef.current = 0;
    stableScriptAlignRef.current = null;
    scriptAlignCandidateRef.current = null;
    scriptAlignLowConfidenceRef.current = 0;
    setScriptAlignDebug(null);
    setStableScriptAlign(null);
  }, [scriptWords]);

  const timedScriptCursor = useTimedScriptCursor(
    scriptWords,
    timedWordQueueRef,
    timedWordState.current,
    { fallbackChunkId: state.activeId },
  );

  const seedScriptAlignCursor = useCallback((chunkId: number) => {
    const firstActiveWord = scriptWordsRef.current.find((word) => word.chunkId === chunkId);
    if (firstActiveWord) scriptAlignCursorRef.current = firstActiveWord.globalIndex;
  }, []);

  const handleJumpTo = useCallback(
    (id: number) => {
      seedScriptAlignCursor(id);
      stableScriptAlignRef.current = null;
      scriptAlignCandidateRef.current = null;
      scriptAlignLowConfidenceRef.current = 0;
      setStableScriptAlign(null);
      jumpTo(id);
    },
    [jumpTo, seedScriptAlignCursor]
  );

  // Reset anchor on paragraph change.
  useEffect(() => {
    const cur = state.chunks[state.activeId];
    const words = cur ? tokenizeChunk(cur.text) : [];
    const seeded = cur ? clamp(alignChunkPrefix(words, rolling), 0, words.length) : 0;
    chunkWordCountRef.current = words.length;
    anchorCursorRef.current = seeded;
    anchorTimeRef.current = performance.now();
    hasTranscriptAnchorRef.current = seeded > 0;
    wordCursorRef.current = seeded;
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

  useEffect(() => {
    const scriptWords = scriptWordsRef.current;
    const transcript = rolling.trim();
    if (!transcript || scriptWords.length === 0) {
      setScriptAlignDebug(null);
      return;
    }

    const result = alignTranscriptToScript(scriptWords, transcript, {
      cursorIndex: scriptAlignCursorRef.current,
      lookBehind: 12,
      lookAhead: 90,
      backstepCap: 12,
    });

    if (result.confidence >= 0.35) {
      scriptAlignCursorRef.current = result.cursorIndex;
    }

    const matchedWord = result.matchedScriptIndex != null ? scriptWords[result.matchedScriptIndex] : undefined;
    const cursorWord = scriptWords[Math.min(result.cursorIndex, scriptWords.length - 1)];
    const word = matchedWord ?? cursorWord;

    setScriptAlignDebug({
      result,
      chunkId: word?.chunkId ?? null,
      localIndex: word?.localIndex ?? null,
      wordText: word?.text ?? null,
    });

    const rawChunkId = word?.chunkId;
    const rawLocalIndex = word?.localIndex;
    if (
      rawChunkId == null ||
      rawLocalIndex == null ||
      result.confidence < SCRIPT_ALIGN_DISPLAY_CONFIDENCE ||
      result.matchedContentTokens < 2
    ) {
      scriptAlignLowConfidenceRef.current += 1;
      if (scriptAlignLowConfidenceRef.current >= 3 && stableScriptAlignRef.current != null) {
        stableScriptAlignRef.current = null;
        scriptAlignCandidateRef.current = null;
        setStableScriptAlign(null);
      }
    } else {
      scriptAlignLowConfidenceRef.current = 0;
      const previous = stableScriptAlignRef.current;
      let nextStable: StableScriptAlign | null = previous;

      if (!previous) {
        const candidate = scriptAlignCandidateRef.current;
        const count = candidate?.chunkId === rawChunkId ? candidate.count + 1 : 1;
        scriptAlignCandidateRef.current = { chunkId: rawChunkId, count };
        if (rawChunkId === state.activeId || count >= SCRIPT_ALIGN_SWITCH_CONFIRMATIONS) {
          nextStable = { chunkId: rawChunkId, localIndex: rawLocalIndex, confidence: result.confidence };
        }
      } else if (previous.chunkId === rawChunkId) {
        scriptAlignCandidateRef.current = null;
        const localIndex =
          rawLocalIndex >= previous.localIndex
            ? Math.min(rawLocalIndex, previous.localIndex + SCRIPT_ALIGN_MAX_WORD_ADVANCE)
            : Math.max(rawLocalIndex, previous.localIndex - SCRIPT_ALIGN_MAX_WORD_BACKSTEP);
        nextStable = { chunkId: rawChunkId, localIndex, confidence: result.confidence };
      } else {
        const candidate = scriptAlignCandidateRef.current;
        const count = candidate?.chunkId === rawChunkId ? candidate.count + 1 : 1;
        scriptAlignCandidateRef.current = { chunkId: rawChunkId, count };
        if (result.confidence >= SCRIPT_ALIGN_SWITCH_CONFIDENCE && count >= SCRIPT_ALIGN_SWITCH_CONFIRMATIONS) {
          nextStable = { chunkId: rawChunkId, localIndex: rawLocalIndex, confidence: result.confidence };
        }
      }

      if (
        nextStable !== previous &&
        (nextStable?.chunkId !== previous?.chunkId ||
          nextStable?.localIndex !== previous?.localIndex ||
          nextStable?.confidence !== previous?.confidence)
      ) {
        stableScriptAlignRef.current = nextStable;
        setStableScriptAlign(nextStable);
      }
    }

    if (import.meta.env.DEV) {
      const uiWord = wordCursorRef.current;
      const agree = word?.chunkId === state.activeId;
      console.info(
        `[dual-sync] ui=${state.activeId}:${uiWord} sa=${word?.chunkId ?? '-'}:${word?.localIndex ?? '-'} ` +
          `conf=${result.confidence.toFixed(2)} match=${result.matchedContentTokens}/${result.transcriptContentTokens} ` +
          `agree=${agree ? 'yes' : 'no'} text=${JSON.stringify(transcript)}`
      );
      console.debug('[scriptAlign]', {
        uiChunk: state.activeId,
        alignChunk: word?.chunkId ?? null,
        word: word?.localIndex ?? null,
        text: word?.text ?? null,
        confidence: Number(result.confidence.toFixed(2)),
        matched: `${result.matchedTokens}/${result.transcriptTokens}`,
        cursor: result.cursorIndex,
        window: `${result.windowStart}-${result.windowEnd}`,
        transcript,
      });
    }
  }, [rolling, state.activeId]);

  const timedCursorActive = timedScriptCursor?.active === true;
  const scriptAlignVisual = false;
  const visualActiveId = timedCursorActive ? timedScriptCursor.chunkId : state.activeId;

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
      wordCursorRef.current = next;
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
  }, [visualActiveId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') handleJumpTo(Math.min(visualActiveId + 1, state.chunks.length - 1));
      else if (e.key === 'ArrowUp') handleJumpTo(Math.max(visualActiveId - 1, 0));
      else if (e.key === ' ') {
        e.preventDefault();
        mic.state.listening ? mic.stop() : mic.start();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleJumpTo, visualActiveId, state.chunks.length, mic]);

  const activeSlide = state.chunks[visualActiveId]?.slide;
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
          {state.ready && ` · chunk#${visualActiveId} · slide ${activeSlide ?? '-'}`}
          {state.lastMatch && state.ready && ` · sim=${state.lastMatch.rawScore.toFixed(2)}`}
          {timedWordState.total > 0 &&
            ` · queue=${timedWordState.total}${timedWordState.current ? ` "${timedWordState.current.text}"` : ''}`}
          {timedScriptCursor &&
            ` · script=${timedScriptCursor.chunkId}:${timedScriptCursor.localWordIndex} ${timedScriptCursor.confidence.toFixed(2)}${timedCursorActive ? '' : ' warming'}`}
        </div>
      </div>

      <div className="main">
        <div className="pane">
          <div className="pane-header">Script ({state.chunks.length} chunks)</div>
          <div className="script">
            {state.chunks.length === 0 && <div style={{ color: 'var(--muted)' }}>No script loaded. Click "Load script".</div>}
            {state.chunks.map((c) => {
              const isActive = c.id === visualActiveId;
              const isScriptAlignChunk = stableScriptAlign?.chunkId === c.id;
              const scriptAlignAgrees = scriptAlignVisual && stableScriptAlign?.chunkId === state.activeId;
              const cls =
                isActive
                  ? 'active'
                  : c.id < visualActiveId
                    ? 'past'
                    : '';
              const alignCls = scriptAlignVisual && isScriptAlignChunk ? (scriptAlignAgrees ? 'align-agree' : 'align-candidate') : '';
              const body = isActive
                ? renderWords(
                    c.text,
                    timedCursorActive
                      ? timedScriptCursor.localWordIndex
                      : scriptAlignVisual && isScriptAlignChunk
                        ? stableScriptAlign.localIndex
                        : wordCursor,
                    {
                      currentClass:
                        timedCursorActive || (scriptAlignVisual && isScriptAlignChunk)
                          ? 'script-current'
                          : 'current',
                    }
                  )
                : scriptAlignVisual && isScriptAlignChunk
                  ? renderWords(c.text, stableScriptAlign.localIndex, { currentClass: 'shadow-current', showRead: false })
                  : c.text;
              return (
                <div
                  key={c.id}
                  ref={isActive ? activeRef : null}
                  className={`chunk ${cls} ${alignCls}`}
                  onClick={() => handleJumpTo(c.id)}
                >
                  {scriptAlignVisual && isScriptAlignChunk && !scriptAlignAgrees && <span className="align-badge">ScriptAlign</span>}
                  {c.slide != null && <span style={{ opacity: 0.5, fontSize: '0.7em' }}>[slide {c.slide}] </span>}
                  {body}
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

      <div className="bottom-bar">
        <div className="transcript">
          {mic.state.listening ? '🎙 ' : '○ '}
          {error ? `⚠ ${error}` : rolling || 'idle — press Space or click Start tracking'}
        </div>
        {scriptAlignDebug && (
          <div
            className={`align-debug ${scriptAlignDebug.chunkId === state.activeId ? 'agree' : 'diverge'}`}
            title={`word: ${scriptAlignDebug.wordText ?? '-'} · window ${scriptAlignDebug.result.windowStart}-${scriptAlignDebug.result.windowEnd}`}
          >
            <span>ScriptAlign</span>
            <span>ui #{state.activeId}</span>
            <span>sa #{scriptAlignDebug.chunkId ?? '-'}</span>
            <span>word {scriptAlignDebug.localIndex ?? '-'}</span>
            <span>conf {scriptAlignDebug.result.confidence.toFixed(2)}</span>
            <span>match {scriptAlignDebug.result.matchedTokens}/{scriptAlignDebug.result.transcriptTokens}</span>
          </div>
        )}
      </div>
    </div>
  );
}
