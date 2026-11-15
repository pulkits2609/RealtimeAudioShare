import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationSounds } from './sounds';

const oscillators: { stop: ReturnType<typeof vi.fn>; onended?: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
const resume = vi.fn();
const close = vi.fn();

class SilentAudioContext {
  state = 'suspended';
  currentTime = 0;
  destination = {};
  async resume() { await resume(); this.state = 'running'; }
  async close() { close(); this.state = 'closed'; }
  createOscillator() {
    const node = { frequency: { value: 0 }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: undefined as (() => void) | undefined };
    oscillators.push(node); return node;
  }
  createGain() { return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }; }
}

beforeEach(() => {
  oscillators.length = 0;
  resume.mockReset(); close.mockReset();
  vi.stubGlobal('AudioContext', SilentAudioContext);
  vi.spyOn(Date, 'now').mockReturnValue(1000);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('notification sounds without real audio output', () => {
  it('stays silent until unlocked and throttles overlapping event bursts', async () => {
    const sounds = new NotificationSounds();
    sounds.play('message'); expect(oscillators).toHaveLength(0);
    await sounds.unlock(); expect(resume).toHaveBeenCalledOnce();
    sounds.play('connected'); expect(oscillators).toHaveLength(2);
    sounds.play('message'); expect(oscillators).toHaveLength(2);
    vi.mocked(Date.now).mockReturnValue(1300);
    sounds.play('message'); expect(oscillators).toHaveLength(3);
    sounds.close();
  });

  it('cancels pending notes before a caller begins outgoing capture', async () => {
    const sounds = new NotificationSounds(); await sounds.unlock(); sounds.play('connected');
    sounds.silence();
    for (const oscillator of oscillators) expect(oscillator.stop).toHaveBeenCalledWith();
    sounds.silence();
    for (const oscillator of oscillators) expect(oscillator.stop).toHaveBeenCalledTimes(2);
    sounds.close(); expect(close).toHaveBeenCalledOnce();
    vi.mocked(Date.now).mockReturnValue(1500); sounds.play('message'); expect(oscillators).toHaveLength(2);
  });

  it('does not block joining when audio permission or initialization fails', async () => {
    resume.mockRejectedValue(new Error('Audio is blocked'));
    const sounds = new NotificationSounds();
    await expect(sounds.unlock()).resolves.toBeUndefined();
    sounds.play('message'); expect(oscillators).toHaveLength(0); sounds.close();
  });

  it('does not schedule tones for zero or invalid notification volume', async () => {
    const sounds = new NotificationSounds(); await sounds.unlock();
    sounds.play('message', 0); sounds.play('message', Number.NaN);
    expect(oscillators).toHaveLength(0);
    sounds.play('message', .5); expect(oscillators).toHaveLength(1);
    sounds.close();
  });
});
