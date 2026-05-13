import { pipeline, env, type FeatureExtractionPipeline } from '@xenova/transformers';

env.allowLocalModels = true;
env.allowRemoteModels = true;

let extractor: FeatureExtractionPipeline | null = null;

export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return extractor;
}

export async function embed(text: string): Promise<Float32Array> {
  const e = await getEmbedder();
  const out = await e(text, { pooling: 'mean', normalize: true });
  return out.data as Float32Array;
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const e = await getEmbedder();
  const out = await e(texts, { pooling: 'mean', normalize: true });
  const dim = out.dims[out.dims.length - 1];
  const flat = out.data as Float32Array;
  const result: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    result.push(flat.slice(i * dim, (i + 1) * dim));
  }
  return result;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
