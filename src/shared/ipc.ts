export const IPC = {
  LOAD_SCRIPT: 'scripter:loadScript',
  LOAD_SLIDES: 'scripter:loadSlides',
  LOAD_PDF: 'scripter:loadPdf',
  STT_INIT: 'scripter:sttInit',
  STT_TRANSCRIBE: 'scripter:sttTranscribe',
  EMBED_TEXTS: 'scripter:embedTexts',
  EMBED_TEXT: 'scripter:embedText',
} as const;

export interface LoadedScript {
  path: string;
  text: string;
}

export interface LoadedSlides {
  dir: string;
  images: string[];
}

export interface SttInitResult {
  ready: boolean;
  model: string;
  error?: string;
}

export interface WordTiming {
  text: string;
  /** ms offset from the start of the audio chunk */
  startMs: number;
  endMs: number;
}

export interface SttTranscribeResult {
  text: string;
  durationMs: number;
  words: WordTiming[];
  /**
   * Wall-clock (renderer `performance.now()`) timestamp of the START of the audio chunk.
   * Echoed back from the renderer's request so word timings can be converted to absolute
   * time without an epoch mismatch between renderer and main. Optional for backward compat.
   */
  chunkStartWallClockMs?: number;
}

export interface LoadedPdf {
  path: string;
  bytes: ArrayBuffer;
}
