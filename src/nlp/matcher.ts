import { cosine } from './embed.js';
import type { ScriptChunk } from './chunk.js';

export interface MatchOptions {
  localitySigma: number;
  backwardPenalty: number;
  minConfidence: number;
  stickiness: number;
  advanceMargin: number;
  advanceConfirmations: number;
}

export const DEFAULT_OPTS: MatchOptions = {
  localitySigma: 6,
  backwardPenalty: 0.6,
  minConfidence: 0.25,
  stickiness: 0.12,
  advanceMargin: 0.08,
  advanceConfirmations: 3,
};

export interface MatchResult {
  chunkId: number;
  rawScore: number;
  adjustedScore: number;
  committed: boolean;
}

export class Matcher {
  private cursor = 0;
  private pendingId: number | null = null;
  private pendingCount = 0;
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
    this.pendingId = null;
    this.pendingCount = 0;
  }

  match(transcriptEmbed: Float32Array): MatchResult {
    let best = { id: 0, raw: -1, adj: -Infinity };
    let curRaw = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const raw = cosine(transcriptEmbed, this.chunkEmbeds[i]);
      const dist = i - this.cursor;
      const sigma = this.opts.localitySigma;
      const locality = Math.exp(-(dist * dist) / (2 * sigma * sigma));
      const backward = dist < 0 ? this.opts.backwardPenalty : 1;
      const stick = i === this.cursor ? this.opts.stickiness : 0;
      const adj = raw * locality * backward + stick;
      if (i === this.cursor) curRaw = raw;
      if (adj > best.adj) best = { id: i, raw, adj };
    }

    const aboveConf = best.raw >= this.opts.minConfidence;
    const margin = best.raw - curRaw;
    let committed = false;

    if (aboveConf) {
      if (best.id === this.cursor) {
        committed = true;
        this.pendingId = null;
        this.pendingCount = 0;
      } else if (margin >= this.opts.advanceMargin) {
        if (best.id === this.pendingId) {
          this.pendingCount += 1;
          if (this.pendingCount >= this.opts.advanceConfirmations) {
            this.cursor = best.id;
            this.pendingId = null;
            this.pendingCount = 0;
            committed = true;
          }
        } else {
          this.pendingId = best.id;
          this.pendingCount = 1;
        }
      } else {
        this.pendingId = null;
        this.pendingCount = 0;
      }
    }

    return {
      chunkId: this.cursor,
      rawScore: best.raw,
      adjustedScore: best.adj,
      committed,
    };
  }
}
