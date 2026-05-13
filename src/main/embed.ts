import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const cacheDir = join(app.getPath('userData'), 'transformers-cache');
if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

type Extractor = (input: string | string[], opts: { pooling: 'mean'; normalize: boolean }) =>
  Promise<{ data: Float32Array; dims: number[] }>;

let extractor: Extractor | null = null;
let loadPromise: Promise<Extractor> | null = null;

async function getEmbedder(): Promise<Extractor> {
  if (extractor) return extractor;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const mod = await import('@xenova/transformers');
    mod.env.allowLocalModels = false;
    mod.env.allowRemoteModels = true;
    (mod.env as any).cacheDir = cacheDir;
    console.log('[main-embed] loading MiniLM (first call may fetch ~80MB)...');
    const t0 = Date.now();
    const pipe = await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log(`[main-embed] loaded in ${Date.now() - t0}ms`);
    extractor = pipe as unknown as Extractor;
    return extractor;
  })();
  return loadPromise;
}

export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const e = await getEmbedder();
  const out = await e(texts, { pooling: 'mean', normalize: true });
  const dim = out.dims[out.dims.length - 1];
  const flat = out.data;
  const result: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    result.push(new Float32Array(flat.slice(i * dim, (i + 1) * dim)));
  }
  return result;
}

export async function embedText(text: string): Promise<Float32Array> {
  const e = await getEmbedder();
  const out = await e(text, { pooling: 'mean', normalize: true });
  return new Float32Array(out.data);
}
