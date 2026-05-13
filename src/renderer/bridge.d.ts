import type {
  LoadedScript,
  LoadedSlides,
  LoadedPdf,
  SttInitResult,
  SttTranscribeResult,
} from '../shared/ipc';

declare global {
  interface Window {
    scripter: {
      loadScript: () => Promise<LoadedScript | null>;
      loadSlides: () => Promise<LoadedSlides | null>;
      loadPdf: () => Promise<LoadedPdf | null>;
      sttInit: () => Promise<SttInitResult>;
      sttTranscribe: (pcm: ArrayBuffer, sampleRate: number) => Promise<SttTranscribeResult>;
    };
  }
}

export {};
