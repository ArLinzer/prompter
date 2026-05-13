import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';

contextBridge.exposeInMainWorld('scripter', {
  loadScript: () => ipcRenderer.invoke(IPC.LOAD_SCRIPT),
  loadSlides: () => ipcRenderer.invoke(IPC.LOAD_SLIDES),
  loadPdf: () => ipcRenderer.invoke(IPC.LOAD_PDF),
  sttInit: () => ipcRenderer.invoke(IPC.STT_INIT),
  sttTranscribe: (pcm: ArrayBuffer, sampleRate: number) =>
    ipcRenderer.invoke(IPC.STT_TRANSCRIBE, { pcm, sampleRate }),
});
