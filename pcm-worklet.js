// Runs on the audio thread at the device's native rate (usually 48 kHz). Input 0 = your mic,
// input 1 = call (system) audio, input 2 = note-taker bot. Downsamples to 16 kHz and writes one
// interleaved 16-bit channel per input, posting ~1 s chunks. While muted the mic channel is silence.
// Why not AudioContext({ sampleRate: 16000 })? Letting Chromium resample live MediaStreams to
// 16 kHz produced dropouts and repeated blocks that made Whisper output nonsense.
const OUT_RATE = 16000;

const toInt16 = (x) => {
  const s = Math.max(-1, Math.min(1, x));
  return s < 0 ? s * 0x8000 : s * 0x7fff;
};

class PcmWriter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ch = options?.numberOfInputs || 2;
    this.ratio = sampleRate / OUT_RATE; // input frames per output frame, e.g. 3 or 2.75625
    this.next = this.ratio; // input position at which the next output sample is due
    this.pos = 0;
    this.sum = new Array(this.ch).fill(0);
    this.count = 0;
    this.buf = new Int16Array(OUT_RATE * this.ch);
    this.n = 0;
    this.muted = false;
    this.port.onmessage = (e) => (e.data === 'flush' ? this.flush() : (this.muted = !!e.data.muted));
  }
  flush() {
    if (this.n) this.port.postMessage(this.buf.slice(0, this.n).buffer);
    this.n = 0;
  }
  process(inputs) {
    const chans = inputs.map((x, c) => (c === 0 && this.muted ? undefined : x[0]));
    const frames = inputs.find((x) => x[0])?.[0].length || 0; // an unconnected input arrives as an empty array
    for (let i = 0; i < frames; i++) {
      // Box-average the input frames that fall into each output sample (inputs are already
      // low-passed below 8 kHz by a BiquadFilter in the graph, so this does not alias).
      for (let c = 0; c < this.ch; c++) this.sum[c] += chans[c] ? chans[c][i] : 0;
      this.count++;
      if (++this.pos >= this.next) {
        for (let c = 0; c < this.ch; c++) this.buf[this.n++] = toInt16(this.sum[c] / this.count);
        this.sum.fill(0);
        this.count = 0;
        this.next += this.ratio;
        if (this.n === this.buf.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('pcm-writer', PcmWriter);
