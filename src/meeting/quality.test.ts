import { expect, it } from 'vitest';
import { audioBitrate, audioPublishOptions, cappedDimensions, receiverHeights, VIDEO_PROFILES, videoPublishOptions } from './quality';
it('reduces audio bitrate when the link degrades for every quality preference', () => {
  for (const quality of ['adaptive', 'music', 'studio'] as const) {
    expect(audioBitrate(quality, 'excellent')).toBeGreaterThan(audioBitrate(quality, 'poor'));
    expect(audioBitrate(quality, 'poor')).toBeGreaterThan(audioBitrate(quality, 'lost'));
  }
});
it('offers bounded video caps and ordered fallback layers for adaptive subscriptions', () => {
  expect(VIDEO_PROFILES['4k'].width).toBe(3840);
  for (const quality of Object.keys(VIDEO_PROFILES) as (keyof typeof VIDEO_PROFILES)[]) {
    const options = videoPublishOptions(quality);
    expect(options.simulcast).toBe(true);
    expect(options.screenShareEncoding?.maxBitrate).toBeLessThanOrEqual(18_000_000);
    const layers = options.screenShareSimulcastLayers!;
    expect(layers[0].width).toBeLessThan(layers[1].width);
  }
});
it('keeps full-rate stereo packets free of RED aggregation and starts at the selected bitrate', () => {
  for (const [quality, bitrate] of [['adaptive', 192000], ['music', 256000], ['studio', 510000]] as const) {
    const options = audioPublishOptions(quality, 'excellent');
    expect(options.red).toBe(false); expect(options.forceStereo).toBe(true); expect(options.dtx).toBe(false);
    expect(options.audioPreset?.maxBitrate).toBe(bitrate);
  }
  expect(audioPublishOptions('studio', 'lost').audioPreset?.maxBitrate).toBe(64000);
});
it('receiver caps never exceed the actual source, including portrait and unknown streams', () => {
  expect(receiverHeights()).toEqual([]);
  expect(receiverHeights(1280, 720, [360, 540, 720, 1440])).toEqual([360, 540, 720]);
  expect(receiverHeights(900, 600)).toEqual([600]);
  expect(receiverHeights(Infinity, 1080)).toEqual([]);
  expect(cappedDimensions(1280, 720, 2160)).toEqual({ width: 1280, height: 720 });
  expect(cappedDimensions(1080, 1920, 720)).toEqual({ width: 405, height: 720 });
});
it('host FPS and content preferences reach encoder policy without forcing unsupported rates', () => {
  for (const fps of [30, 45, 60] as const) {
    expect(videoPublishOptions('1080p', fps).screenShareEncoding?.maxFramerate).toBe(fps);
    expect(videoPublishOptions('1080p', fps, 'text').degradationPreference).toBe('maintain-resolution');
    expect(videoPublishOptions('1080p', fps, 'motion').degradationPreference).toBe('maintain-framerate');
  }
});
