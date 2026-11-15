import { afterEach, expect, it, vi } from 'vitest';
import { startCapture } from './capture';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => { vi.unstubAllGlobals(); });
function fixture(loads: Promise<void>[]) {
  let load = 0;
  const stop = vi.fn(async () => {}), start = vi.fn(async (_device: string) => ({ sampleRate: 48000, channels: 2 }));
  const addModule = vi.fn(() => loads[load++] ?? Promise.resolve());
  const bridge = { startCapture: start, stopCapture: stop, onAudio: () => () => {}, onCaptureError: () => () => {} };
  vi.stubGlobal('window', { audioShareDesktop: bridge });
  vi.stubGlobal('AudioContext', class {
    audioWorklet = { addModule };
    resume = async () => {}; close = async () => {};
    createAnalyser = () => ({});
    createMediaStreamDestination = () => ({ stream: { getTracks: () => [{ stop() {} }] } });
  });
  vi.stubGlobal('AudioWorkletNode', class { port = { postMessage() {}, close() {} }; connect() {} disconnect() {} });
  return { start, stop, addModule };
}
it('an old worklet initialization cannot replace or stop a newer Windows capture', async () => {
  const oldLoad = deferred(), f = fixture([oldLoad.promise, Promise.resolve()]);
  const old = startCapture('old', () => {}).then(source => ({ source }), error => ({ error }));
  await vi.waitFor(() => expect(f.addModule).toHaveBeenCalledOnce());
  const current = await startCapture('current', () => {});
  oldLoad.resolve();
  const result = await old;
  if ('source' in result) await result.source!.stop();
  expect(f.start.mock.calls.map(call => call[0])).toEqual(['current']);
  expect(f.stop).not.toHaveBeenCalled();
  await current.stop(); expect(f.stop).toHaveBeenCalledOnce();
});
it('aborting a pending native initialization never starts an output capture', async () => {
  const load = deferred(), f = fixture([load.promise]), abort = new AbortController();
  const pending = startCapture('cancelled', () => {}, abort.signal).catch(error => error);
  abort.abort(); load.resolve();
  expect((await pending).name).toBe('AbortError');
  expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
});
it('a cancelled newer request does not prevent cleanup of the active older native session', async () => {
  const load = deferred(), f = fixture([Promise.resolve(), load.promise]);
  const active = await startCapture('active', () => {});
  const abort = new AbortController();
  const next = startCapture('cancelled', () => {}, abort.signal).catch(error => error);
  await vi.waitFor(() => expect(f.addModule).toHaveBeenCalledTimes(2));
  await active.stop(); abort.abort(); load.resolve();
  expect((await next).name).toBe('AbortError');
  expect(f.start.mock.calls.map(call => call[0])).toEqual(['active']);
  expect(f.stop).toHaveBeenCalledOnce();
});
