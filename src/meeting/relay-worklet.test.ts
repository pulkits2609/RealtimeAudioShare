import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
interface Node { port: { onmessage(event: { data: unknown }): void; postMessage(data: unknown): void }; process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean; available?: number }
function nodes() {
  const constructors: Record<string, new () => Node> = {};
  runInNewContext(readFileSync(new URL('./relay-worklet.js', import.meta.url), 'utf8'), {
    ArrayBuffer, currentTime: 0, AudioWorkletProcessor: class { port = { postMessage() {} }; },
    registerProcessor: (name: string, ctor: new () => Node) => { constructors[name] = ctor; },
  });
  return constructors;
}
function pcm(left = 0.25, right = -0.5) {
  const buffer = new ArrayBuffer(7680), view = new DataView(buffer);
  for (let i = 0; i < 960; i++) { view.setFloat32(i * 8, left, true); view.setFloat32(i * 8 + 4, right, true); }
  return buffer;
}
describe('server relay audio frames', () => {
  it('packs exact stereo float samples into 20ms frames with increasing sequence', () => {
    const node = new (nodes()['relay-capture'])(), frames: ArrayBuffer[] = [];
    node.port.postMessage = frame => frames.push((frame as { buffer: ArrayBuffer }).buffer);
    for (let i = 0; i < 15; i++) node.process([[new Float32Array(128).fill(0.25), new Float32Array(128).fill(-0.5)]], []);
    expect(frames).toHaveLength(2);
    expect(frames[0].byteLength).toBe(7688); expect([...new Uint8Array(frames[0], 0, 4)]).toEqual([65, 83, 70, 49]);
    expect(new DataView(frames[0]).getFloat32(8, true)).toBe(0.25); expect(new DataView(frames[0]).getFloat32(12, true)).toBe(-0.5);
    expect(new DataView(frames[1]).getUint32(4, true)).toBe(1);
  });
  it('buffers 100ms before playback and preserves independent channels', () => {
    const node = new (nodes()['relay-playout'])();
    const output = () => [new Float32Array(128), new Float32Array(128)];
    node.port.onmessage({ data: { buffer: pcm() } }); const first = output(); node.process([], [first]); expect(first[0][0]).toBe(0);
    for (let i = 0; i < 4; i++) node.port.onmessage({ data: { buffer: pcm() } }); const second = output(); node.process([], [second]);
    expect(second[0][0]).toBe(0.25); expect(second[1][0]).toBe(-0.5);
  });
  it('bounds playout latency, clears old audio on stop, and sanitizes invalid samples', () => {
    const node = new (nodes()['relay-playout'])();
    for (let i = 0; i < 15; i++) node.port.onmessage({ data: { buffer: pcm() } });
    expect(node.available).toBeLessThanOrEqual(14400);
    node.port.onmessage({ data: { reset: true } }); expect(node.available).toBe(0);
    for (let i = 0; i < 5; i++) node.port.onmessage({ data: { buffer: pcm(NaN, Infinity) } });
    const output = [new Float32Array(128), new Float32Array(128)]; node.process([], [output]);
    expect([...output[0], ...output[1]].every(value => value === 0)).toBe(true);
  });
});
