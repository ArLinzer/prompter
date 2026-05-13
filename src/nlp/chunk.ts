export interface ScriptChunk {
  id: number;
  text: string;
  start: number;
  end: number;
  slide?: number;
}

const SLIDE_RE = /\[\[slide:(\d+)\]\]/g;

export function chunkScript(raw: string): ScriptChunk[] {
  const chunks: ScriptChunk[] = [];
  let currentSlide: number | undefined = undefined;
  let cursor = 0;

  const stripped = raw.replace(SLIDE_RE, (match, num, offset) => {
    return ' '.repeat(match.length);
  });

  const slideMarkers: Array<{ pos: number; slide: number }> = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(SLIDE_RE.source, 'g');
  while ((m = re.exec(raw)) !== null) {
    slideMarkers.push({ pos: m.index, slide: parseInt(m[1], 10) });
  }

  const sentenceRe = /[^.!?\n]+[.!?]+|\S[^.!?\n]*$/g;
  let s: RegExpExecArray | null;
  let id = 0;
  while ((s = sentenceRe.exec(stripped)) !== null) {
    const text = s[0].trim();
    if (!text) continue;
    const start = s.index;
    const end = start + s[0].length;

    for (const sm of slideMarkers) {
      if (sm.pos <= end) currentSlide = sm.slide;
    }

    chunks.push({ id: id++, text, start, end, slide: currentSlide });
  }

  return chunks;
}
