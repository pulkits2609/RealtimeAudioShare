import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';

interface Source {
  port: { onmessage: (event: { data: { buffer: ArrayBufferLike; channels: number; inputRate: number } }) => void };
  process(inputs: never[], outputs: Float32Array[][]): boolean;
  available: number;
  buffering: boolean;
}
function source(buffering = false) {
  let Constructor: new () => Source;
  runInNewContext(readFileSync(new URL('./pcm-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { port = {}; }, sampleRate: 48000,
    registerProcessor: (_name: string, cls: new () => Source) => { Constructor = cls; },
  });
  const node = new Constructor!(); node.buffering = buffering; return node;
}
function push(node: Source, samples: Float32Array, channels = 2, inputRate = 48000) { node.port.onmessage({ data: { buffer: samples.buffer, channels, inputRate } }); }
describe('native PCM audio bridge', () => {
  it('preserves stereo channel separation and emits silence on underrun', () => {
    const node = source(); push(node, new Float32Array([0.25, -0.5, 0.75, -1]));
    const left = new Float32Array(4), right = new Float32Array(4);
    node.process([], [[left, right]]);
    expect([...left]).toEqual([0.25, 0.75, 0, 0]); expect([...right]).toEqual([-0.5, -1, 0, 0]);
  });
  it('bounds queued latency after a renderer stall', () => {
    const node = source(); push(node, new Float32Array(48000 * 2));
    expect(node.available).toBeLessThanOrEqual(7680);
  });
  it('converts 44.1kHz mono into stereo at the worklet rate', () => {
    const node = source(); push(node, new Float32Array(441).fill(0.5), 1, 44100);
    expect(node.available).toBeGreaterThanOrEqual(479); expect(node.available).toBeLessThanOrEqual(481);
    const left = new Float32Array(128), right = new Float32Array(128); node.process([], [[left, right]]);
    expect([...left]).toEqual([...right]); expect(left[100]).toBe(0.5);
  });
  it('sanitizes non-finite samples', () => {
    const node = source(); push(node, new Float32Array([NaN, Infinity]));
    const left = new Float32Array(1), right = new Float32Array(1); node.process([], [[left, right]]);
    expect(left[0]).toBe(0); expect(right[0]).toBe(0);
  });
  it('absorbs native batch delivery jitter without inserting zero gaps', () => {
    const node = source(true); let frame = 0, missing = 0;
    for (let clock = 0; clock < 96000; clock += 128) {
      while (frame * 960 + (frame % 11 === 7 ? 960 : 0) <= clock) { push(node, new Float32Array(1920).fill(0.25)); frame++; }
      const left = new Float32Array(128), right = new Float32Array(128); node.process([], [[left, right]]);
      if (clock > 4800) missing += left.filter(sample => sample === 0).length;
    }
    expect(missing).toBe(0);
  });
  it('tracks independent capture and playback clocks without recurring underruns', () => {
    for (const drift of [-0.001, 0.001]) {
      const node = source(true); let frame = 0, missing = 0;
      const packet = new Float32Array(1920).fill(0.25);
      for (let clock = 0; clock < 48000 * 60; clock += 128) {
        while (frame * 960 / (1 + drift) <= clock) { push(node, packet); frame++; }
        const left = new Float32Array(128), right = new Float32Array(128); node.process([], [[left, right]]);
        if (clock > 4800) missing += left.filter(sample => sample === 0).length;
      }
      expect(missing).toBe(0);
      expect(node.available).toBeLessThan(4800);
    }
  }, 15000);
});
