// Runs pcm-worklet.js outside the browser with stubbed AudioWorklet globals.
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');

function load(rate) {
  let Proc;
  const posted = [];
  vm.runInNewContext(fs.readFileSync(`${__dirname}/pcm-worklet.js`, 'utf8'), {
    sampleRate: rate,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (b) => posted.push(b) }; } },
    registerProcessor: (_n, c) => { Proc = c; },
    Int16Array, Math,
  });
  return { p: new Proc(), posted };
}

for (const rate of [48000, 44100]) {
  const { p, posted } = load(rate);
  const secs = 2;
  for (let f = 0; f < rate * secs; f += 128) {
    const mic = new Float32Array(128).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * (f + i)) / rate));
    const call = new Float32Array(128).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * (f + i)) / rate));
    p.process([[mic], [call]]);
  }
  p.flush();
  const out = new Int16Array(Buffer.concat(posted.map((b) => Buffer.from(b))).buffer.slice(0));
  const frames = out.length / 2;
  const fed = Math.ceil((rate * secs) / 128) * 128; // whole 128-frame blocks
  assert.ok(Math.abs(frames - (fed * 16000) / rate) <= 1, `${rate}: ${frames} frames`);
  const zc = (ch) => { let z = 0; for (let i = 1; i < frames; i++) if ((out[2 * (i - 1) + ch] < 0) !== (out[2 * i + ch] < 0)) z++; return z / secs / 2; };
  assert.ok(Math.abs(zc(0) - 440) < 5, `${rate} mic freq ${zc(0)}`); // pitch preserved, left = mic
  assert.ok(Math.abs(zc(1) - 1000) < 5, `${rate} call freq ${zc(1)}`); // right = call
  const peak = Math.max(...out.filter((_, i) => i % 2 === 0).slice(100));
  assert.ok(peak > 0.45 * 32767 && peak < 0.51 * 32767, `${rate} level ${peak}`);
}

// a mic-only recording (call input unconnected) still produces stereo with a silent right channel
const { p, posted } = load(48000);
p.process([[new Float32Array(128).fill(0.25)], []]);
p.flush();
const o = new Int16Array(Buffer.from(posted[0]).buffer.slice(0));
assert.ok(o.length > 0 && o.every((v, i) => (i % 2 ? v === 0 : v > 8000)));
console.log('worklet resampling ok');

// three inputs (mic, call, bot); muting zeroes only the mic channel
{
  let Proc;
  const out = [];
  vm.runInNewContext(fs.readFileSync(`${__dirname}/pcm-worklet.js`, 'utf8'), {
    sampleRate: 48000, Int16Array, Math,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (b) => out.push(b) }; } },
    registerProcessor: (_n, c) => { Proc = c; },
  });
  const p = new Proc({ numberOfInputs: 3 });
  const block = (v) => [new Float32Array(128).fill(v)];
  p.process([block(0.25), block(0.5), []]);
  p.port.onmessage({ data: { muted: true } });
  p.process([block(0.25), block(0.5), block(0.75)]);
  p.port.onmessage({ data: 'flush' });
  const s = new Int16Array(Buffer.from(out[0]).buffer.slice(0));
  const frame = (k) => [...s.slice(3 * k, 3 * k + 3)];
  assert.ok(frame(10)[0] > 8000 && frame(10)[2] === 0, 'before mute: mic on, bot unconnected');
  const last = frame(s.length / 3 - 1);
  assert.ok(last[0] === 0 && last[1] > 16000 && last[2] > 24000, `muted: ${last}`);
}
console.log('worklet 3 channels + mute ok');
