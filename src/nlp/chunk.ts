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

  const slideMarkers: Array<{ pos: number; slide: number }> = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(SLIDE_RE.source, 'g');
  while ((m = re.exec(raw)) !== null) {
    slideMarkers.push({ pos: m.index, slide: parseInt(m[1], 10) });
  }

  const stripped = raw.replace(SLIDE_RE, (match) => ' '.repeat(match.length));
  const paragraphRe = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g;
  let p: RegExpExecArray | null;
  let id = 0;
  while ((p = paragraphRe.exec(stripped)) !== null) {
    const text = p[0].replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = p.index;
    const end = start + p[0].length;

    let currentSlide: number | undefined;
    for (const sm of slideMarkers) {
      if (sm.pos <= end) currentSlide = sm.slide;
      else break;
    }

    chunks.push({ id: id++, text, start, end, slide: currentSlide });
  }

  return chunks;
}
