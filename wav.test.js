const assert = require('node:assert');
const { wavHeader } = require('./wav');

const h = wavHeader(32000);
assert.equal(h.length, 44);
assert.equal(h.toString('ascii', 0, 4), 'RIFF');
assert.equal(h.readUInt32LE(4), 36 + 32000);
assert.equal(h.readUInt32LE(24), 16000);
assert.equal(h.readUInt32LE(28), 32000);
assert.equal(h.readUInt16LE(34), 16);
assert.equal(h.readUInt32LE(40), 32000);
console.log('wav header ok');
const st = wavHeader(64000, 16000, 2);
assert.equal(st.readUInt16LE(22), 2);
assert.equal(st.readUInt32LE(28), 64000);
assert.equal(st.readUInt16LE(32), 4);
console.log('stereo wav header ok');
