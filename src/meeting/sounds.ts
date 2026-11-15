export type NotificationSound = 'connected' | 'disconnected' | 'peerJoined' | 'peerLeft' | 'message' | 'sharingStarted' | 'sharingStopped' | 'connectionLost' | 'connectionRestored' | 'failure';
const notes: Record<NotificationSound, number[]> = {
  connected: [440, 660], disconnected: [440, 330], peerJoined: [523, 659], peerLeft: [440, 349], message: [740],
  sharingStarted: [392, 587], sharingStopped: [587, 392], connectionLost: [330, 294], connectionRestored: [440, 659], failure: [294, 277],
};

/** Quiet local notifications. The caller must suppress these during outgoing capture. */
export class NotificationSounds {
  private context: AudioContext | null = null;
  private lastPlayed = 0;
  private active = new Set<OscillatorNode>();

  async unlock() {
    try {
      this.context ??= new AudioContext();
      if (this.context.state === 'suspended') await this.context.resume();
    } catch { /* Optional sounds must never block joining a room. */ }
  }

  play(sound: NotificationSound, volume = .5) {
    const context = this.context;
    if (!context || context.state !== 'running' || !Number.isFinite(volume) || volume <= 0 || Date.now() - this.lastPlayed < 220) return;
    this.lastPlayed = Date.now();
    notes[sound].forEach((frequency, index) => {
      const start = context.currentTime + index * .09;
      const oscillator = context.createOscillator();
      this.active.add(oscillator);
      const gain = context.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(.05 * Math.min(1, volume), start + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, start + .12);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.onended = () => { this.active.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(start); oscillator.stop(start + .14);
    });
  }

  silence() {
    for (const oscillator of this.active) { try { oscillator.stop(); } catch { /* Already ended. */ } }
    this.active.clear();
  }

  close() { this.silence(); const context = this.context; this.context = null; void context?.close().catch(() => {}); }
}
