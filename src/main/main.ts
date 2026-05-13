import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IPC, type LoadedScript, type LoadedSlides, type LoadedPdf } from '../shared/ipc';
import { initStt, transcribe } from './stt';
import { embedText, embedTexts } from './embed';

const isDev = !!process.env.VITE_DEV_SERVER_URL;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (_evt, level, message, line, sourceId) => {
    if (message.startsWith('[match]') || message.startsWith('[transcript]') || message.startsWith('[tracker]') || message.startsWith('[app]')) {
      console.log(message);
    }
  });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL!);
    win.webContents.openDevTools();
  } else {
    win.loadFile(join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));
  }
}

ipcMain.handle(IPC.LOAD_SCRIPT, async (): Promise<LoadedScript | null> => {
  const r = await dialog.showOpenDialog({
    title: 'Open script',
    filters: [{ name: 'Text', extensions: ['txt', 'md'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const path = r.filePaths[0];
  const text = readFileSync(path, 'utf-8');
  return { path, text };
});

ipcMain.handle(IPC.LOAD_SLIDES, async (): Promise<LoadedSlides | null> => {
  const r = await dialog.showOpenDialog({
    title: 'Open slides folder (PNG/JPG per slide, sorted by name)',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  const files = readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile());
  return { dir, images: files };
});

ipcMain.handle(IPC.LOAD_PDF, async (): Promise<LoadedPdf | null> => {
  const r = await dialog.showOpenDialog({
    title: 'Open PDF slides',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const path = r.filePaths[0];
  const buf = readFileSync(path);
  return { path, bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
});

ipcMain.handle(IPC.STT_INIT, async () => initStt());

ipcMain.handle(IPC.EMBED_TEXTS, async (_evt, texts: string[]) => {
  const vecs = await embedTexts(texts);
  return vecs.map((v) => Array.from(v));
});

ipcMain.handle(IPC.EMBED_TEXT, async (_evt, text: string) => {
  const v = await embedText(text);
  return Array.from(v);
});

ipcMain.handle(
  IPC.STT_TRANSCRIBE,
  async (_evt, payload: { pcm: ArrayBuffer; sampleRate: number }) => {
    const pcm = new Int16Array(payload.pcm);
    return transcribe(pcm, payload.sampleRate);
  }
);

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
