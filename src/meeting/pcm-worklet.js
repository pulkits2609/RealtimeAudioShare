// A bounded float PCM queue. Old samples are dropped when the renderer stalls,
// so a slow machine cannot accumulate seconds of playback latency.
class PcmSource extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(48000);
    this.right = new Float32Array(48000);
    this.write = 0;
    this.read = 0;
    this.available = 0;
    this.phase = 0;
    this.buffering = true;
    this.readFraction = 0;
    this.smoothedDepth = sampleRate * 0.03;
    this.port.onmessage = ({ data }) => {
      const samples = new Float32Array(data.buffer);
      const channels = data.channels;
      const frames = Math.floor(samples.length / channels);
      if (!frames || channels < 1 || data.inputRate < 1) return;
      const step = data.inputRate / sampleRate;
      for (; this.phase < frames; this.phase += step) {
        const i = Math.floor(this.phase);
        const j = Math.min(i + 1, frames - 1);
        const f = this.phase - i;
        const l = samples[i * channels] * (1 - f) + samples[j * channels] * f;
        const ri = Math.min(channels - 1, 1);
        const r = samples[i * channels + ri] * (1 - f) + samples[j * channels + ri] * f;
        this.left[this.write] = Number.isFinite(l) ? l : 0;
        this.right[this.write] = Number.isFinite(r) ? r : 0;
        this.write = (this.write + 1) % this.left.length;
        this.available++;
        if (this.available > sampleRate * 0.16) {
          this.read = (this.read + 1) % this.left.length;
          this.available--;
        }
      }
      this.phase -= frames;
    };
  }
  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    if (this.buffering && this.available < sampleRate * 0.04) return true;
    this.buffering = false;
    // WASAPI and Web Audio have independent hardware clocks. Average over packet
    // arrivals, then gently resample rather than periodically dropping a packet
    // or running dry. The 20 ms packet sawtooth must not drive the controller.
    this.smoothedDepth += (this.available - this.smoothedDepth) * 0.002;
    const error = this.smoothedDepth - sampleRate * 0.03;
    const correction = Math.abs(error) < sampleRate * 0.005 ? 0 : Math.max(-0.002, Math.min(0.002, error / (sampleRate * 2)));
    const step = 1 + correction;
    for (let i = 0; i < left.length; i++) {
      if (this.available > 0) {
        const next = this.available > 1 ? (this.read + 1) % this.left.length : this.read;
        left[i] = this.left[this.read] * (1 - this.readFraction) + this.left[next] * this.readFraction;
        right[i] = this.right[this.read] * (1 - this.readFraction) + this.right[next] * this.readFraction;
        this.readFraction += step;
        const consumed = Math.min(this.available, Math.floor(this.readFraction));
        this.readFraction -= consumed;
        this.read = (this.read + consumed) % this.left.length; this.available -= consumed;
      } else { left[i] = 0; right[i] = 0; this.buffering = true; this.readFraction = 0; this.smoothedDepth = sampleRate * 0.03; }
    }
    return true;
  }
}
registerProcessor('pcm-source', PcmSource);
