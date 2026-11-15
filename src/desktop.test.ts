import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installDesktopBridge } from './desktop';

const native = vi.hoisted(() => ({
  enabled: true,
  channels: [] as { onmessage: (value: unknown) => void }[],
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => native.enabled,
  invoke: native.invoke,
  Channel: class {
    onmessage: (value: unknown) => void = () => {};
    constructor() { native.channels.push(this); }
  },
}));
beforeEach(() => {
  native.enabled = true; native.channels.length = 0;
  native.invoke.mockReset().mockImplementation(async (command: string) => command === 'capture_start' ? { sampleRate: 48000, channels: 2, generation: 7 } : undefined);
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  vi.stubGlobal('navigator', { userAgent: 'Windows' });
});
afterEach(() => vi.unstubAllGlobals());

function packet(generation = 7, frameId = 1) {
  const bytes = new ArrayBuffer(24), view = new DataView(bytes);
  [generation, frameId, 48000, 2].forEach((value, index) => view.setUint32(index * 4, value, true));
  view.setFloat32(16, .25, true); view.setFloat32(20, -.5, true);
  return bytes;
}

it('a browser preview does not install or call the native bridge', async () => {
  native.enabled = false;
  await installDesktopBridge();
  expect(window.audioShareDesktop).toBeUndefined();
  expect(native.invoke).not.toHaveBeenCalled();
});
it('raw PCM preserves sample bytes, acknowledges consumed packets and unsubscribes', async () => {
  await installDesktopBridge();
  const bridge = window.audioShareDesktop!, received = vi.fn();
  const unsubscribe = bridge.onAudio(received);
  await bridge.startCapture('test-device');
  native.channels[0].onmessage(packet());
  expect(received).toHaveBeenCalledOnce();
  const frame = received.mock.calls[0][0];
  expect([...new Float32Array(frame.samples.buffer, frame.samples.byteOffset, 2)]).toEqual([.25, -.5]);
  expect(native.invoke).toHaveBeenCalledWith('capture_ack', { generation: 7, frameId: 1 });
  unsubscribe(); native.channels[0].onmessage(packet(7, 2));
  expect(received).toHaveBeenCalledOnce();
});
it('stopped and stale-generation packets are discarded and acknowledged', async () => {
  await installDesktopBridge();
  const bridge = window.audioShareDesktop!, received = vi.fn();
  bridge.onAudio(received);
  await bridge.startCapture('test-device');
  native.channels[0].onmessage(packet(6));
  await bridge.stopCapture();
  native.channels[0].onmessage(packet(7, 2));
  expect(received).not.toHaveBeenCalled();
  expect(native.invoke).toHaveBeenCalledWith('capture_ack', { generation: 6, frameId: 1 });
  expect(native.invoke).toHaveBeenCalledWith('capture_ack', { generation: 7, frameId: 2 });
});
it('a throwing consumer cannot block the channel acknowledgement', async () => {
  await installDesktopBridge();
  const bridge = window.audioShareDesktop!, errors = vi.fn();
  bridge.onCaptureError(errors); bridge.onAudio(() => { throw new Error('test consumer failure'); });
  await bridge.startCapture('test-device');
  native.channels[0].onmessage(packet());
  expect(errors).toHaveBeenCalledOnce();
  expect(native.invoke).toHaveBeenCalledWith('capture_ack', { generation: 7, frameId: 1 });
});
