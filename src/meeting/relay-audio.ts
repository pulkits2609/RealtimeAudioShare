import workletUrl from './relay-worklet.js?url';

export interface CaptureFrame { buffer: ArrayBuffer; createdAt: number }
interface FramePort { onmessage: ((event: MessageEvent<CaptureFrame>) => void) | null; postMessage(data: { reset?: boolean; buffer?: ArrayBuffer }, transfer?: Transferable[]): void; close(): void }
export interface RelayNode { node: AudioNode; port: FramePort; disconnect(): void }

export async function prepareRelay(context: AudioContext): Promise<boolean> {
  if (!context.audioWorklet) return false;
  await context.audioWorklet.addModule(workletUrl); return true;
}
function nativeNode(node: AudioWorkletNode): RelayNode { return { node, port: node.port, disconnect: () => { node.disconnect(); node.port.close(); } }; }

// HTTP listeners cannot use AudioWorklet. Keep listening possible using the
// older Web Audio callback API; capture permission itself still requires HTTPS.
export function relayPlayout(context: AudioContext, worklet: boolean): RelayNode {
  if (worklet) return nativeNode(new AudioWorkletNode(context, 'relay-playout', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] }));
  const node = context.createScriptProcessor(2048, 1, 2);
  const silence = context.createConstantSource(); silence.offset.value = 0; silence.connect(node); silence.start();
  const left = new Float32Array(32768), right = new Float32Array(32768);
  let read = 0, write = 0, available = 0, buffering = true;
  const port: FramePort = { onmessage: null, close() {}, postMessage(data) {
    if (data.reset) { read = write = available = 0; buffering = true; return; }
    if (!data.buffer || data.buffer.byteLength !== 7680) return;
    const view = new DataView(data.buffer);
    for (let i = 0; i < 960; i++) {
      const l = view.getFloat32(i * 8, true), r = view.getFloat32(i * 8 + 4, true);
      left[write] = Number.isFinite(l) ? Math.max(-1, Math.min(1, l)) : 0; right[write] = Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : 0;
      write = (write + 1) % 32768; if (++available > 14400) { available--; read = (read + 1) % 32768; }
    }
  } };
  node.onaudioprocess = event => {
    const l = event.outputBuffer.getChannelData(0), r = event.outputBuffer.getChannelData(1); l.fill(0); r.fill(0);
    if (buffering && available < 4800) return; buffering = false;
    for (let i = 0; i < l.length; i++) { if (!available) { buffering = true; break; } l[i] = left[read]; r[i] = right[read]; read = (read + 1) % 32768; available--; }
  };
  return { node, port, disconnect() { node.onaudioprocess = null; silence.stop(); silence.disconnect(); node.disconnect(); } };
}
export function relayCapture(context: AudioContext, worklet: boolean): RelayNode {
  if (worklet) return nativeNode(new AudioWorkletNode(context, 'relay-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit' }));
  const node = context.createScriptProcessor(2048, 2, 1);
  const port: FramePort = { onmessage: null, postMessage() {}, close() { port.onmessage = null; } };
  let sequence = 0, offset = 0, frame: ArrayBuffer, view: DataView;
  function next() { frame = new ArrayBuffer(7688); new Uint8Array(frame).set([65, 83, 70, 49]); view = new DataView(frame); view.setUint32(4, sequence++, true); offset = 0; } next();
  node.onaudioprocess = event => {
    event.outputBuffer.getChannelData(0).fill(0);
    const l = event.inputBuffer.getChannelData(0), r = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : l;
    for (let i = 0; i < l.length; i++) {
      view.setFloat32(8 + offset * 8, Number.isFinite(l[i]) ? l[i] : 0, true); view.setFloat32(12 + offset * 8, Number.isFinite(r[i]) ? r[i] : 0, true);
      if (++offset === 960) { port.onmessage?.({ data: { buffer: frame, createdAt: event.playbackTime } } as MessageEvent<CaptureFrame>); next(); }
    }
  };
  return { node, port, disconnect() { port.close(); node.onaudioprocess = null; node.disconnect(); } };
}
