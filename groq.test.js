const assert = require('node:assert');
const { splitPoints } = require('./groq');

const RATE = 16000;
// 25 "minutes" of loud noise (scaled down: 1 s chunks), with one silent 100 ms gap before each cut.
const pcm = new Int16Array(25 * RATE).fill(10000);
pcm.fill(0, Math.round(9.3 * RATE), Math.round(9.4 * RATE));   // pause 0.7 s before the 10 s mark
pcm.fill(0, Math.round(19.05 * RATE), Math.round(19.15 * RATE)); // pause before the next mark (on the 100 ms window grid)

const pts = splitPoints(pcm, 10, 1); // chunks of 10 s, search 1 s back
assert.equal(pts.length, 2);
assert.equal(pts[0], Math.round(9.35 * RATE)); // middle of the first pause
assert.equal(pts[1], Math.round(19.1 * RATE)); // measured from the first cut, finds the second pause
assert.deepEqual(splitPoints(new Int16Array(5 * RATE), 10, 1), []); // short audio: no cuts
// search window longer than a chunk: must still advance (used to loop forever)
const long = splitPoints(new Int16Array(30 * RATE).fill(10000), 8, 10);
assert.ok(long.length >= 3 && long.every((p, i) => p > (long[i - 1] ?? 0)));
console.log('split points ok');
