import type { CaptureMode } from './types';
import workletUrl from './pcm-worklet.js?url';
import { VIDEO_PROFILES, type VideoQuality, type VideoFps, type SharingMode } from './video-policy';

export interface Capture {
  stream: MediaStream;
  label: string;
  context: AudioContext;
  analyser: AnalyserNode;
  stop(): Promise<void>;
}
export interface ScreenCapture { stream: MediaStream; label: string; stop(): Promise<void> }
let nativeOwner = 0;
let nativeActiveOwner = 0;
let nativeCommands: Promise<unknown> = Promise.resolve();
function nativeCommand<T>(operation: () => Promise<T>): Promise<T> {
  const task = nativeCommands.then(operation); nativeCommands = task.catch(() => {}); return task;
}
export function captureAvailability(): string | undefined {
  if (!window.isSecureContext) return 'This page is not a trusted secure context. Open the HTTPS address with a valid certificate; HTTPS server settings alone cannot grant browser capture access.';
  if (!navigator.mediaDevices?.getDisplayMedia) return 'Screen/system-audio capture is unavailable in this browser or embedded view. Use a supported desktop browser or the native app. Mobile browsers may not offer display capture.';
}
export function captureError(error: unknown): Error {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError') return new Error('Sharing was cancelled or blocked. Allow screen recording in your browser and operating-system permissions, then choose a source again.');
  if (name === 'NotReadableError') return new Error('The selected source could not be captured. Check operating-system screen-recording permissions or choose another window.');
  if (name === 'InvalidStateError') return new Error('Start sharing directly from the Share button in the active window.');
  if (name === 'OverconstrainedError') return new Error('The source cannot supply these capture settings. Choose a lower resolution or frame rate.');
  return error instanceof Error ? error : new Error(String(error));
}
export async function startScreenCapture(quality: VideoQuality, onEnded: () => void, fps: VideoFps = 30, mode: SharingMode = 'motion'): Promise<ScreenCapture> {
  const unavailable = captureAvailability(); if (unavailable) throw new Error(unavailable);
  const profile = VIDEO_PROFILES[quality];
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { ideal: profile.width }, height: { ideal: profile.height }, frameRate: { ideal: fps, max: fps } },
    audio: window.audioShareDesktop ? false : { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
    systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude',
    suppressLocalAudioPlayback: false,
  } as DisplayMediaStreamOptions).catch(error => { throw captureError(error); });
  const video = stream.getVideoTracks()[0];
  if (!video) { stream.getTracks().forEach(track => track.stop()); throw new Error('The screen picker returned no video. Choose a screen or window.'); }
  video.contentHint = mode === 'text' ? 'detail' : 'motion';
  video.addEventListener('ended', onEnded, { once: true });
  return { stream, label: video.label || 'Screen share', stop: async () => { stream.getTracks().forEach(track => track.stop()); } };
}

export async function startCapture(deviceId: string, onEnded: () => void, signal?: AbortSignal, mode: CaptureMode = 'endpoint'): Promise<Capture> {
  const bridge = window.audioShareDesktop;
  const owner = bridge ? ++nativeOwner : 0;
  const cancelled = () => signal?.aborted || Boolean(bridge && owner !== nativeOwner);
  const assertActive = () => { if (cancelled()) throw new DOMException('Capture request was cancelled.', 'AbortError'); };
  const stopNative = () => nativeCommand(async () => {
    if (owner !== nativeActiveOwner) return;
    await bridge?.stopCapture().catch(() => {}); nativeActiveOwner = 0;
  });
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  let capture: Capture | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeError: (() => void) | undefined;
  let display: MediaStream | undefined;
  let nativeStarted = false;
  let nativeReady = false;
  try {
    await context.resume();
    assertActive();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    if (bridge) {
      await context.audioWorklet.addModule(workletUrl);
      assertActive();
      const node = new AudioWorkletNode(context, 'pcm-source', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      const destination = context.createMediaStreamDestination();
      destination.channelCount = 2;
      node.connect(destination);
      node.connect(analyser);
      unsubscribe = bridge.onAudio(data => {
        if (cancelled() || !nativeReady || owner !== nativeActiveOwner) return;
        const bytes = typeof data.samples === 'string' ? Uint8Array.from(atob(data.samples), c => c.charCodeAt(0)) : new Uint8Array(data.samples);
        node.port.postMessage({ buffer: bytes.buffer, channels: data.channels, inputRate: data.sampleRate }, [bytes.buffer]);
      });
      unsubscribeError = bridge.onCaptureError(() => { if (!cancelled()) onEnded(); });
      await nativeCommand(async () => { assertActive(); nativeStarted = true; nativeActiveOwner = owner; await bridge.startCapture(deviceId, mode); nativeReady = true; });
      assertActive();
      let stopped = false;
      capture = { stream: destination.stream, label: 'Windows output device', context, analyser, stop: async () => {
        if (stopped) return; stopped = true;
        unsubscribe?.(); unsubscribeError?.();
        node.disconnect(); node.port.close(); destination.stream.getTracks().forEach(t => t.stop());
        await Promise.all([stopNative(), context.close()]);
      } };
    } else {
      const unavailable = captureAvailability(); if (unavailable) throw new Error(unavailable);
      // Browsers require a display picker even though only the audio track is transmitted.
      display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
        systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude',
      } as DisplayMediaStreamOptions).catch(error => { throw captureError(error); });
      assertActive();
      const audio = display.getAudioTracks()[0];
      if (!audio) throw new Error('No audio was shared. Try again, select a tab or entire screen, and enable “Share audio” in the picker.');
      const stream = new MediaStream([audio]);
      context.createMediaStreamSource(stream).connect(analyser);
      audio.addEventListener('ended', onEnded, { once: true });
      display.getVideoTracks().forEach(t => t.addEventListener('ended', onEnded, { once: true }));
      const source = display;
      capture = { stream, label: audio.label || 'Browser audio', context, analyser, stop: async () => {
        source.getTracks().forEach(t => t.stop()); await context.close();
      } };
    }
    return capture;
  } catch (error) {
    unsubscribe?.(); unsubscribeError?.();
    if (nativeStarted) await stopNative();
    display?.getTracks().forEach(t => t.stop());
    await context.close().catch(() => {});
    throw error;
  }
}
