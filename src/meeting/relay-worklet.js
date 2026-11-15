// Fixed 48 kHz stereo Float32 PCM; one 20 ms frame per WebSocket message.
class RelayCapture extends AudioWorkletProcessor {
  constructor() { super(); this.sequence = 0; this.newFrame(); }
  newFrame() {
    this.frame = new ArrayBuffer(7688); new Uint8Array(this.frame).set([65, 83, 70, 49]);
    this.view = new DataView(this.frame); this.view.setUint32(4, this.sequence++, true); this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0]; if (!input?.[0]) return true;
    const left = input[0], right = input[1] || left;
    for (let i = 0; i < left.length; i++) {
      this.view.setFloat32(8 + this.offset * 8, Number.isFinite(left[i]) ? left[i] : 0, true);
      this.view.setFloat32(12 + this.offset * 8, Number.isFinite(right[i]) ? right[i] : 0, true);
      if (++this.offset === 960) { this.port.postMessage({ buffer: this.frame, createdAt: currentTime }, [this.frame]); this.newFrame(); }
    }
    return true;
  }
}
class RelayPlayout extends AudioWorkletProcessor {
  constructor() {
    super(); this.left = new Float32Array(32768); this.right = new Float32Array(32768); this.reset();
    this.port.onmessage = ({ data }) => {
      if (data.reset) { this.reset(); return; }
      if (!(data.buffer instanceof ArrayBuffer) || data.buffer.byteLength !== 7680) return;
      const view = new DataView(data.buffer);
      for (let i = 0; i < 960; i++) {
        const l = view.getFloat32(i * 8, true), r = view.getFloat32(i * 8 + 4, true);
        this.left[this.write] = Number.isFinite(l) ? Math.max(-1, Math.min(1, l)) : 0;
        this.right[this.write] = Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : 0;
        this.write = (this.write + 1) % 32768;
        if (++this.available > 14400) { this.available--; this.read = (this.read + 1) % 32768; }
      }
    };
  }
  reset() { this.read = this.write = this.available = 0; this.buffering = true; }
  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    if (this.buffering && this.available < 4800) return true;
    this.buffering = false;
    for (let i = 0; i < left.length; i++) {
      if (!this.available) { this.buffering = true; break; }
      left[i] = this.left[this.read]; right[i] = this.right[this.read]; this.read = (this.read + 1) % 32768; this.available--;
    }
    return true;
  }
}
registerProcessor('relay-capture', RelayCapture);
registerProcessor('relay-playout', RelayPlayout);
