import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import type { CaptureMode, DesktopBridge, NativeAudio, OutputDevice } from './meeting/types';

/** Install the real desktop bridge before React mounts; browsers keep the WebRTC fallback. */
export async function installDesktopBridge(): Promise<void> {
  if (!isTauri()) return;

  const audioListeners = new Set<(audio: NativeAudio) => void>();
  const errorListeners = new Set<(message: string) => void>();
  let activeGeneration: number | undefined;
  const report = (message: string) => {
    for (const listener of errorListeners) {
      try { listener(message); } catch { /* One consumer cannot block native cleanup. */ }
    }
  };
  const audio = new Channel<ArrayBuffer>();
  const errors = new Channel<string>();
  errors.onmessage = report;
  audio.onmessage = buffer => {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16) {
      report('Native capture returned an invalid audio packet.');
      return;
    }
    const header = new DataView(buffer);
    const generation = header.getUint32(0, true);
    const frameId = header.getUint32(4, true);
    const sampleRate = header.getUint32(8, true);
    const channels = header.getUint32(12, true);
    try {
      if (generation !== activeGeneration) return;
      if (channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 192000
        || (buffer.byteLength - 16) % (channels * 4)) {
        report('Native capture returned invalid audio metadata.');
        return;
      }
      const frame: NativeAudio = { samples: new Uint8Array(buffer, 16), sampleRate, channels };
      for (const listener of audioListeners) {
        try { listener(frame); } catch { report('The audio consumer could not accept a capture frame.'); }
      }
    } finally {
      // Four raw packets at most may be in flight; ack even if the consumer stopped.
      void invoke('capture_ack', { generation, frameId }).catch(() => {});
    }
  };

  await invoke('capture_subscribe', { audio, errors });

  const bridge: DesktopBridge = {
    platform: navigator.userAgent.includes('Windows') ? 'windows' : 'tauri',
    listOutputDevices: async () => {
      const result = await invoke<{ devices: OutputDevice[]; defaultDeviceId: string | null }>('capture_devices');
      return { devices: result.devices, defaultDeviceId: result.defaultDeviceId || '' };
    },
    getCaptureCapabilities: () => invoke('capture_capabilities'),
    getCaptureStats: () => invoke('capture_stats'),
    startCapture: async (deviceId: string, mode: CaptureMode = 'endpoint') => {
      activeGeneration = undefined;
      const result = await invoke<{ sampleRate: number; channels: number; generation: number }>('capture_start', { deviceId, mode });
      activeGeneration = result.generation;
      return result;
    },
    stopCapture: () => {
      activeGeneration = undefined;
      return invoke('capture_stop');
    },
    beginMicrophoneSession: (deviceId?: string) => invoke('microphone_begin_session', { deviceId: deviceId || null }),
    endMicrophoneSession: () => invoke('microphone_end_session'),
    onAudio: callback => {
      audioListeners.add(callback);
      return () => { audioListeners.delete(callback); };
    },
    onCaptureError: callback => {
      errorListeners.add(callback);
      return () => { errorListeners.delete(callback); };
    },
  };
  window.audioShareDesktop = bridge;
  window.addEventListener('pagehide', () => { void invoke('capture_close').catch(() => {}); });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
  });
}
