function normalize(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  const prev = new Array(n + 1).fill(0).map((_, i) => i);
  const cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

function fuzzyEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const maxDist = a.length <= 3 || b.length <= 3 ? 0 : a.length <= 5 ? 1 : 2;
  return levenshtein(a, b, maxDist) <= maxDist;
}

export interface ChunkWord {
  text: string;
  start: number;
  end: number;
}

export function tokenizeChunk(text: string): ChunkWord[] {
  const out: ChunkWord[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Walk transcript tokens left-to-right; for each token find the next fuzzy
 * match in the chunk's word list at-or-after the current alignment cursor.
 * Returns the index of the last successfully matched chunk word + 1 (i.e.
 * the index of the next word the reader is expected to speak).
 */
export function alignWordCursor(chunkWords: ChunkWord[], transcript: string): number {
  const normChunk = chunkWords.map((w) => normalize(w.text)).filter(Boolean);
  if (normChunk.length === 0) return 0;
  const tt = transcript.split(/\s+/).map(normalize).filter(Boolean);
  if (tt.length === 0) return 0;

  let bestCursor = 0;
  let cursor = 0;
  const lookAhead = 12;

  for (const t of tt) {
    let found = -1;
    const upper = Math.min(chunkWords.length, cursor + lookAhead);
    for (let i = cursor; i < upper; i++) {
      if (fuzzyEqual(normChunk[i], t)) {
        found = i;
        break;
      }
    }
    if (found === -1 && cursor < chunkWords.length) {
      const start = Math.max(0, cursor - 2);
      for (let i = start; i < chunkWords.length; i++) {
        if (fuzzyEqual(normChunk[i], t)) {
          found = i;
          break;
        }
      }
    }
    if (found !== -1) {
      cursor = found + 1;
      if (cursor > bestCursor) bestCursor = cursor;
    }
  }

  return bestCursor;
}
