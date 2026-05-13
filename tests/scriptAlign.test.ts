import { describe, expect, it } from 'vitest';
import { chunkScript } from '../src/nlp/chunk';
import { alignTranscriptToScript, tokenizeScriptChunks } from '../src/nlp/scriptAlign';

function wordsFromScript(script: string) {
  return tokenizeScriptChunks(chunkScript(script));
}

describe('scriptAlign', () => {
  it('aligns a noisy transcript with missed stop words and filler', () => {
    const words = wordsFromScript('Welcome to the revenue section. The market is growing quickly from here.');

    const result = alignTranscriptToScript(words, 'welcome um revenue section market is growing', {
      cursorIndex: 0,
      lookAhead: 20,
    });

    expect(result.confidence).toBeGreaterThan(0.55);
    expect(result.cursorIndex).toBe(9);
    expect(words[result.cursorIndex - 1].normalized).toBe('growing');
  });

  it('skips over missed script words while preserving order', () => {
    const words = wordsFromScript('Alpha beta gamma delta epsilon zeta.');

    const result = alignTranscriptToScript(words, 'alpha delta zeta', {
      cursorIndex: 0,
      lookAhead: 10,
    });

    expect(result.confidence).toBeGreaterThan(0.45);
    expect(result.cursorIndex).toBe(6);
  });

  it('does not let repeated stop words create high-confidence anchors by themselves', () => {
    const words = wordsFromScript('The plan is the story of the product and the customer.');

    const result = alignTranscriptToScript(words, 'the the of and the', {
      cursorIndex: 0,
      lookAhead: 20,
    });

    expect(result.confidence).toBeLessThan(0.45);
    expect(result.matchedContentTokens).toBe(0);
  });

  it('uses content words to disambiguate repeated common phrases', () => {
    const words = wordsFromScript(
      'The platform is simple. The platform helps teams coordinate work with confidence.',
    );

    const result = alignTranscriptToScript(words, 'platform helps teams coordinate', {
      cursorIndex: 4,
      lookBehind: 2,
      lookAhead: 20,
    });

    expect(result.confidence).toBeGreaterThan(0.6);
    expect(result.cursorIndex).toBe(9);
    expect(words[result.cursorIndex - 1].normalized).toBe('coordinate');
  });

  it('can align across a paragraph boundary without needing paragraph state first', () => {
    const words = wordsFromScript(`The old paragraph ends with a setup.

The new paragraph begins with a concrete recommendation.`);

    const result = alignTranscriptToScript(words, 'new paragraph begins concrete recommendation', {
      cursorIndex: 5,
      lookBehind: 4,
      lookAhead: 20,
    });

    expect(result.confidence).toBeGreaterThan(0.55);
    expect(result.cursorIndex).toBe(words.length);
    expect(words[result.cursorIndex - 1].chunkId).toBe(1);
  });

  it('caps backward search so stale anchors do not jump far back locally', () => {
    const words = wordsFromScript('One two three four five six seven eight nine ten eleven twelve.');

    const result = alignTranscriptToScript(words, 'one two three', {
      cursorIndex: 10,
      lookBehind: 10,
      backstepCap: 3,
      lookAhead: 3,
    });

    expect(result.confidence).toBeLessThan(0.35);
    expect(result.windowStart).toBe(7);
  });

  it('keeps semantic paraphrases low-confidence without lexical evidence', () => {
    const words = wordsFromScript('Revenue growth is strong because customer retention improved.');

    const result = alignTranscriptToScript(words, 'sales are going up because people keep renewing', {
      cursorIndex: 0,
      lookAhead: 20,
    });

    expect(result.confidence).toBeLessThan(0.45);
  });
});
