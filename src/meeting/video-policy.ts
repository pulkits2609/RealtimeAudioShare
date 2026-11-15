export type VideoQuality = 'auto' | '720p' | '1080p' | '1440p' | '4k';
export type AudioQuality = 'adaptive' | 'music' | 'studio';
export type VideoFps = 30 | 45 | 60;
export type SharingMode = 'text' | 'motion';
export function receiverHeights(width?: number, height?: number, publishedLayers: number[] = []): number[] {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return [];
  return [...new Set([...publishedLayers, Math.round(height)].filter(value => Number.isFinite(value) && value >= 1 && value <= height))].sort((a, b) => a - b);
}
export function cappedDimensions(width: number, height: number, requestedHeight: number) {
  const cappedHeight = Math.max(1, Math.min(Math.round(requestedHeight), height));
  return { width: Math.max(1, Math.min(width, Math.round(width * cappedHeight / height))), height: cappedHeight };
}
export const VIDEO_PROFILES: Record<VideoQuality, { width: number; height: number; frameRate: number; bitrate: number }> = {
  auto: { width: 1920, height: 1080, frameRate: 30, bitrate: 6_000_000 },
  '720p': { width: 1280, height: 720, frameRate: 30, bitrate: 2_500_000 },
  '1080p': { width: 1920, height: 1080, frameRate: 30, bitrate: 6_000_000 },
  '1440p': { width: 2560, height: 1440, frameRate: 30, bitrate: 10_000_000 },
  '4k': { width: 3840, height: 2160, frameRate: 30, bitrate: 18_000_000 },
};
export function audioBitrate(quality: AudioQuality, connection: string): number {
  if (connection === 'lost') return 64_000;
  if (connection === 'poor') return 128_000;
  return quality === 'studio' ? 510_000 : quality === 'music' ? 256_000 : 192_000;
}
