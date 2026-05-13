import * as pdfjs from 'pdfjs-dist';
// @ts-ignore - vite resolves worker URL
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

const TARGET_WIDTH = 1600;

export async function renderPdfPages(bytes: ArrayBuffer): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport0 = page.getViewport({ scale: 1 });
    const scale = TARGET_WIDTH / viewport0.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d')!;
    await page.render({ canvasContext: ctx, viewport, canvas } as any).promise;

    out.push(canvas.toDataURL('image/png'));
    page.cleanup();
  }
  await doc.destroy();
  return out;
}
