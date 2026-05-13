import type { ScriptChunk } from './chunk';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'with',
]);

const NEGATIVE_INF = -1_000_000;

export interface ScriptWord {
  text: string;
  normalized: string;
  chunkId: number;
  localIndex: number;
  globalIndex: number;
  start: number;
  end: number;
}

export interface ScriptAlignOptions {
  cursorIndex?: number;
  windowStart?: number;
  windowEnd?: number;
  lookBehind?: number;
  lookAhead?: number;
  backstepCap?: number;
  bandRadius?: number;
  gapOpen?: number;
  gapExtend?: number;
  transcriptGapOpen?: number;
  transcriptGapExtend?: number;
  forwardBias?: number;
}

export interface ScriptAlignResult {
  cursorIndex: number;
  matchedScriptIndex: number | null;
  confidence: number;
  score: number;
  matchedTokens: number;
  matchedContentTokens: number;
  transcriptTokens: number;
  transcriptContentTokens: number;
  windowStart: number;
  windowEnd: number;
}

interface AlignCell {
  score: number;
  matchedWeight: number;
  possibleWeight: number;
  matchedTokens: number;
  matchedContentTokens: number;
  matchedScriptIndex: number | null;
}

function emptyCell(score = NEGATIVE_INF): AlignCell {
  return {
    score,
    matchedWeight: 0,
    possibleWeight: 0,
    matchedTokens: 0,
    matchedContentTokens: 0,
    matchedScriptIndex: null,
  };
}

function resetCell(): AlignCell {
  return emptyCell(0);
}

function cloneCell(cell: AlignCell, score = cell.score): AlignCell {
  return { ...cell, score };
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;

  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  const cur = new Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }

  return prev[b.length];
}

function fuzzyScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const maxDist = a.length <= 3 || b.length <= 3 ? 0 : a.length <= 5 ? 1 : 2;
  const dist = levenshtein(a, b, maxDist);
  if (dist > maxDist) return 0;

  return Math.max(0.55, 1 - dist / Math.max(a.length, b.length));
}

function tokenWeight(token: string): number {
  if (!token) return 0;
  return STOP_WORDS.has(token) ? 0.25 : 1;
}

function isContentToken(token: string): boolean {
  return Boolean(token) && !STOP_WORDS.has(token);
}

function transcriptTokens(transcript: string): string[] {
  return transcript.split(/\s+/).map(normalizeToken).filter(Boolean);
}

function bestOf(...cells: AlignCell[]): AlignCell {
  let best = cells[0] ?? emptyCell();
  for (const cell of cells) {
    if (cell.score > best.score) best = cell;
  }
  return best;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function tokenizeScriptChunks(chunks: ScriptChunk[]): ScriptWord[] {
  const out: ScriptWord[] = [];

  for (const chunk of chunks) {
    const re = /\S+/g;
    let match: RegExpExecArray | null;
    let localIndex = 0;

    while ((match = re.exec(chunk.text)) !== null) {
      const normalized = normalizeToken(match[0]);
      if (!normalized) continue;

      out.push({
        text: match[0],
        normalized,
        chunkId: chunk.id,
        localIndex,
        globalIndex: out.length,
        start: chunk.start + match.index,
        end: chunk.start + match.index + match[0].length,
      });
      localIndex += 1;
    }
  }

  return out;
}

export function alignTranscriptToScript(
  scriptWords: ScriptWord[],
  transcript: string,
  options: ScriptAlignOptions = {},
): ScriptAlignResult {
  const tokens = transcriptTokens(transcript);
  const transcriptContentTokens = tokens.filter(isContentToken).length;
  const cursorIndex = clamp(options.cursorIndex ?? 0, 0, scriptWords.length);

  const backstepCap = options.backstepCap ?? 8;
  const lookBehind = options.lookBehind ?? backstepCap;
  const lookAhead = options.lookAhead ?? 80;
  const windowStart = clamp(
    options.windowStart ?? cursorIndex - Math.min(lookBehind, backstepCap),
    0,
    scriptWords.length,
  );
  const windowEnd = clamp(options.windowEnd ?? cursorIndex + lookAhead, windowStart, scriptWords.length);

  if (tokens.length === 0 || windowStart === windowEnd) {
    return {
      cursorIndex,
      matchedScriptIndex: null,
      confidence: 0,
      score: 0,
      matchedTokens: 0,
      matchedContentTokens: 0,
      transcriptTokens: tokens.length,
      transcriptContentTokens,
      windowStart,
      windowEnd,
    };
  }

  const windowWords = scriptWords.slice(windowStart, windowEnd);
  const rowCount = tokens.length + 1;
  const colCount = windowWords.length + 1;
  const matchState = Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => resetCell()));
  const scriptGapState = Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => emptyCell()));
  const transcriptGapState = Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => emptyCell()));

  const gapOpen = options.gapOpen ?? -0.7;
  const gapExtend = options.gapExtend ?? -0.25;
  const transcriptGapOpen = options.transcriptGapOpen ?? -0.5;
  const transcriptGapExtend = options.transcriptGapExtend ?? -0.2;
  const forwardBias = options.forwardBias ?? 0.03;
  const bandRadius = options.bandRadius ?? Math.max(24, Math.ceil(windowWords.length * 0.45));

  let best = resetCell();

  for (let i = 1; i < rowCount; i++) {
    const center = Math.round((i / tokens.length) * windowWords.length);
    const minJ = Math.max(1, center - bandRadius);
    const maxJ = Math.min(windowWords.length, center + bandRadius);

    for (let j = minJ; j <= maxJ; j++) {
      const transcriptToken = tokens[i - 1];
      const scriptWord = windowWords[j - 1];
      const matchQuality = fuzzyScore(transcriptToken, scriptWord.normalized);
      const weight = tokenWeight(transcriptToken);
      const globalIndex = windowStart + j - 1;
      const pairBias = globalIndex >= cursorIndex ? forwardBias : -forwardBias * Math.min(cursorIndex - globalIndex, backstepCap);
      const pairScore = matchQuality > 0 ? weight * (1.4 * matchQuality) + pairBias : -0.55 * weight;
      const previous = bestOf(
        matchState[i - 1][j - 1],
        scriptGapState[i - 1][j - 1],
        transcriptGapState[i - 1][j - 1],
        resetCell(),
      );

      const matched = matchQuality > 0;
      matchState[i][j] = {
        score: Math.max(0, previous.score + pairScore),
        matchedWeight: previous.matchedWeight + (matched ? weight * matchQuality : 0),
        possibleWeight: previous.possibleWeight + weight,
        matchedTokens: previous.matchedTokens + (matched ? 1 : 0),
        matchedContentTokens: previous.matchedContentTokens + (matched && isContentToken(transcriptToken) ? 1 : 0),
        matchedScriptIndex: matched ? scriptWord.globalIndex : previous.matchedScriptIndex,
      };

      const scriptGapFrom = bestOf(
        cloneCell(matchState[i][j - 1], matchState[i][j - 1].score + gapOpen),
        cloneCell(scriptGapState[i][j - 1], scriptGapState[i][j - 1].score + gapExtend),
        cloneCell(transcriptGapState[i][j - 1], transcriptGapState[i][j - 1].score + gapOpen),
        resetCell(),
      );
      scriptGapState[i][j] = scriptGapFrom.score > 0 ? scriptGapFrom : resetCell();

      const transcriptGapWeight = tokenWeight(transcriptToken);
      const transcriptGapFrom = bestOf(
        cloneCell(matchState[i - 1][j], matchState[i - 1][j].score + transcriptGapOpen),
        cloneCell(transcriptGapState[i - 1][j], transcriptGapState[i - 1][j].score + transcriptGapExtend),
        cloneCell(scriptGapState[i - 1][j], scriptGapState[i - 1][j].score + transcriptGapOpen),
        resetCell(),
      );
      transcriptGapState[i][j] = transcriptGapFrom.score > 0
        ? {
            ...transcriptGapFrom,
            possibleWeight: transcriptGapFrom.possibleWeight + transcriptGapWeight,
          }
        : resetCell();

      const candidate = matchState[i][j];
      if (
        candidate.matchedScriptIndex !== null &&
        (candidate.score > best.score ||
          (candidate.score === best.score && candidate.matchedScriptIndex > (best.matchedScriptIndex ?? -1)))
      ) {
        best = candidate;
      }
    }
  }

  const coverage = best.possibleWeight > 0 ? best.matchedWeight / best.possibleWeight : 0;
  const tokenCoverage = tokens.length > 0 ? best.matchedTokens / tokens.length : 0;
  const contentCoverage =
    transcriptContentTokens > 0 ? best.matchedContentTokens / transcriptContentTokens : best.matchedTokens > 1 ? 0.35 : 0;
  const lexicalConfidence = 0.55 * coverage + 0.25 * tokenCoverage + 0.2 * contentCoverage;
  const confidence = clamp(transcriptContentTokens === 0 ? lexicalConfidence * 0.6 : lexicalConfidence, 0, 1);
  const matchedScriptIndex = best.matchedScriptIndex;

  return {
    cursorIndex: matchedScriptIndex === null ? cursorIndex : Math.min(scriptWords.length, matchedScriptIndex + 1),
    matchedScriptIndex,
    confidence,
    score: best.score,
    matchedTokens: best.matchedTokens,
    matchedContentTokens: best.matchedContentTokens,
    transcriptTokens: tokens.length,
    transcriptContentTokens,
    windowStart,
    windowEnd,
  };
}
