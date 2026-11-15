import { Track, VideoPreset, type TrackPublishOptions } from 'livekit-client';
import { audioBitrate, VIDEO_PROFILES, type AudioQuality, type VideoQuality, type VideoFps, type SharingMode } from './video-policy';
export * from './video-policy';
export function videoPublishOptions(quality: VideoQuality, fps: VideoFps = 30, mode: SharingMode = 'motion'): TrackPublishOptions {
  const p = VIDEO_PROFILES[quality];
  return { source: Track.Source.ScreenShare, stream: 'desktop', videoCodec: 'vp8', simulcast: true,
    degradationPreference: mode === 'text' ? 'maintain-resolution' : 'maintain-framerate', screenShareEncoding: { maxBitrate: p.bitrate, maxFramerate: fps },
    screenShareSimulcastLayers: [new VideoPreset(640, 360, 450_000, Math.min(fps, 15)), new VideoPreset(960, 540, 1_200_000, Math.min(fps, 30))],
  };
}
export function audioPublishOptions(quality: AudioQuality, connection: string): TrackPublishOptions {
  // Repeating full-rate stereo Opus frames in RED can exceed the SFU RTP packet
  // budget and silently drop the music packets. Keep RED for low-rate voice;
  // system audio uses primary Opus, its negotiated FEC and WebRTC recovery.
  return { source: Track.Source.ScreenShareAudio, stream: 'desktop', forceStereo: true,
    audioPreset: { maxBitrate: audioBitrate(quality, connection) }, red: false, dtx: false };
}
