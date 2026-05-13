import { cosine } from './embed.js';
import type { ScriptChunk } from './chunk.js';

export interface MatchOptions {
  localitySigma: number;
  backwardPenalty: number;
  minConfidence: number;
  stickiness: number;
}

export const DEFAULT_OPTS: MatchOptions = {
  localitySigma: 6,
  backwardPenalty: 0.6,
  minConfidence: 0.35,
  stickiness: 0.05,
};

export interface MatchResult {
  chunkId: number;
  rawScore: number;
  adjustedScore: number;
  committed: boolean;
}

export class Matcher {
  private cursor = 0;
  private opts: MatchOptions;

  constructor(
    private chunks: ScriptChunk[],
    private chunkEmbeds: Float32Array[],
    opts: Partial<MatchOptions> = {}
  ) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  get position(): number {
    return this.cursor;
  }

  setPosition(id: number): void {
    this.cursor = id;
  }

  match(transcriptEmbed: Float32Array): MatchResult {
    let best = { id: 0, raw: -1, adj: -Infinity };
    for (let i = 0; i < this.chunks.length; i++) {
      const raw = cosine(transcriptEmbed, this.chunkEmbeds[i]);
      const dist = i - this.cursor;
      const sigma = this.opts.localitySigma;
      const locality = Math.exp(-(dist * dist) / (2 * sigma * sigma));
      const backward = dist < 0 ? this.opts.backwardPenalty : 1;
      const stick = i === this.cursor ? this.opts.stickiness : 0;
      const adj = raw * locality * backward + stick;
      if (adj > best.adj) best = { id: i, raw, adj };
    }

    const committed = best.raw >= this.opts.minConfidence;
    if (committed) this.cursor = best.id;

    return {
      chunkId: best.id,
      rawScore: best.raw,
      adjustedScore: best.adj,
      committed,
    };
  }
}
