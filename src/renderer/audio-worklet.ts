// Inlined as a Blob URL so AudioWorklet can load it from Electron.
export const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = [];
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch && ch.length) {
      // Copy — underlying buffer is reused.
      this.port.postMessage(new Float32Array(ch));
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;
