// Inlined as a Blob URL so AudioWorklet can load it from Electron.
//
// The processor emits Float32Array frames plus a per-frame RMS scalar so
// the main thread doesn't have to recompute energy for VAD.
export const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch && ch.length) {
      let sum = 0;
      for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
      const rms = Math.sqrt(sum / ch.length);
      this.port.postMessage({ samples: new Float32Array(ch), rms });
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;
