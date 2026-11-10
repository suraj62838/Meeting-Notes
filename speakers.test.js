const assert = require('node:assert');
const { deinterleave, preferBot, dropEcho, formatTranscript, peakRms, firstSound, isHallucination } = require('./groq');

const seg = (text, no_speech_prob = 0.1) => ({ text, no_speech_prob, avg_logprob: -0.4, compression_ratio: 1.2 });
assert.ok(isHallucination(seg('झाल', 0.79)));
assert.ok(isHallucination(seg('real looking words', 0.87))); // probably no speech
assert.ok(isHallucination(seg(' अजय को अजय को ')));             // filler only
assert.ok(isHallucination(seg('कर दो कि अ')));
assert.ok(isHallucination({ ...seg('ab ab ab ab ab ab'), compression_ratio: 3.1 })); // repeated text
assert.ok(!isHallucination(seg('pricing page deploy कर दो', 0.55))); // real sentence containing filler words
assert.ok(!isHallucination(seg('Okay team, we ship Friday', 0.01)));

const [l, r] = deinterleave(Int16Array.from([1, -1, 2, -2, 3, -3]));
assert.deepEqual([...l], [1, 2, 3]);
assert.deepEqual([...r], [-1, -2, -3]);

const quiet = new Int16Array(16000).fill(20);
assert.ok(peakRms(quiet) < 150);
quiet.fill(3000, 8000, 9600); // one loud 100 ms burst
assert.ok(peakRms(quiet) > 150);
assert.equal(firstSound(quiet, 0, 16000), 8000);
assert.equal(firstSound(quiet, 0, 8000), 8000); // none in range -> end

const segs = [
  { speaker: 'Others', start: 5, end: 9, text: 'Sam, checkout bug Wednesday tak fix ho jana chahiye.' },
  { speaker: 'You', start: 5.3, end: 9.2, text: 'checkout bug Wednesday tak fix ho jana' }, // mic echo of the call
  { speaker: 'You', start: 0, end: 3, text: 'Okay team, let us start.' },
  { speaker: 'You', start: 3.2, end: 4.5, text: 'First item is pricing.' },
  { speaker: 'You', start: 10, end: 12, text: 'Done, I will check.' }, // real reply, no overlap
];
const kept = dropEcho(segs);
assert.equal(kept.length, 4);
assert.ok(!kept.some((s) => s.text === 'checkout bug Wednesday tak fix ho jana'));

assert.equal(
  formatTranscript(kept),
  '[00:00] You: Okay team, let us start. First item is pricing.\n\n' +
  '[00:05] Others: Sam, checkout bug Wednesday tak fix ho jana chahiye.\n\n' +
  '[00:10] You: Done, I will check.',
);
assert.equal(formatTranscript([{ speaker: 'You', start: 3725, end: 3726, text: 'late' }]), '[01:02:05] You: late');
assert.equal(formatTranscript([{ speaker: null, start: 0, end: 1, text: 'mono' }]), 'mono');
const [a, b, c] = deinterleave(Int16Array.from([1, 2, 3, 4, 5, 6]), 3);
assert.deepEqual([[...a], [...b], [...c]], [[1, 4], [2, 5], [3, 6]]);

// bot audio replaces call audio from the bot's first to last sound (100 ms windows), call audio elsewhere
const call = new Int16Array(16000).fill(1000);
const bot = new Int16Array(16000);
bot.fill(5000, 3200, 8000);
const merged = preferBot(call, bot);
assert.deepEqual([merged[3199], merged[3200], merged[7999], merged[8000]], [1000, 5000, 5000, 1000]);
assert.equal(preferBot(call, new Int16Array(16000)), call); // bot never got in

// with the bot, your own words also come back on "Others": silent call audio at that moment means it was you
const you = { speaker: 'You', start: 0.2, end: 0.8, text: 'I will send the deck today' };
const botCopy = { speaker: 'Others', start: 0.3, end: 0.9, text: 'I will send the deck today' };
const other = { speaker: 'Others', start: 0.4, end: 0.9, text: 'okay sounds good' };
const quietCall = new Int16Array(16000);
assert.deepEqual(dropEcho([you, botCopy, other], quietCall), [you, other]);
assert.deepEqual(dropEcho([you, botCopy, other], new Int16Array(16000).fill(3000)), [botCopy, other]); // call was playing: mic echo
console.log('speaker labels ok');
