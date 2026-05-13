export const IPC = {
  LOAD_SCRIPT: 'scripter:loadScript',
  LOAD_SLIDES: 'scripter:loadSlides',
  LOAD_PDF: 'scripter:loadPdf',
  STT_INIT: 'scripter:sttInit',
  STT_TRANSCRIBE: 'scripter:sttTranscribe',
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

export interface SttTranscribeResult {
  text: string;
  durationMs: number;
}

export interface LoadedPdf {
  path: string;
  bytes: ArrayBuffer;
}
