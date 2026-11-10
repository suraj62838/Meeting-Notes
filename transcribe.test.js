const assert = require('node:assert');
const { wavHeader } = require('./wav');
const { transcribe } = require('./groq');

// 1.9 s stereo, cut into 1 s "chunks". A quiet gap at 0.9-1.0 s puts the cut at 0.95 s on both channels.
const RATE = 16000;
const n = Math.round(1.9 * RATE);
const pcm = new Int16Array(n * 2);
for (let i = 0; i < n; i++) {
  const gap = i >= 0.9 * RATE && i < RATE;
  pcm[2 * i] = gap ? 0 : 10000; // mic: loud
  pcm[2 * i + 1] = gap ? 0 : i < RATE ? 100 : 10000; // call: below speech level in piece 1, so it is skipped
}
const wav = Buffer.concat([wavHeader(pcm.byteLength, RATE, 2), Buffer.from(pcm.buffer)]);

// Whisper replies in call order: mic piece 1, mic piece 2, call piece 2. Times are relative to each piece.
const seg = (start, end, text, no_speech_prob = 0.1) => ({ start, end, text, no_speech_prob, avg_logprob: -0.3, compression_ratio: 1.1 });
const replies = [
  [seg(0.1, 0.5, 'hello team'), seg(0.5, 0.8, 'Thank you.', 0.9)], // second one is invented over noise
  [seg(0.3, 0.6, 'second part')],
  [seg(0.0, 0.4, 'from the call')],
];
let calls = 0;
global.fetch = async () => ({ ok: true, json: async () => ({ segments: replies[calls++] }) });

transcribe({ url: 'https://api.test/v1', key: 'k', chatModel: 'm', transcribeModel: 'whisper' }, wav, () => {}, 1).then(({ raw, text }) => {
  assert.equal(calls, 3); // silent call piece never uploaded
  // Others (0.95 s + 0.0) lands between You at 0.1 s and You at 0.95 s + 0.3: only true if piece offsets are added.
  assert.equal(raw, '[00:00] You: hello team\n\n[00:00] Others: from the call\n\n[00:01] You: second part');
  assert.equal(text, raw); // no Devanagari: nothing to romanize, no extra Groq call
  console.log('transcribe pipeline ok');
});

const { tuning, checkAi, baseUrl } = require('./groq');
assert.equal(baseUrl('groq', 'https://evil.test'), 'https://api.groq.com/openai/v1'); // presets ignore the URL field
assert.equal(baseUrl('custom', ' https://openrouter.ai/api/v1/ '), 'https://openrouter.ai/api/v1');
assert.equal(baseUrl('custom', 'http://localhost:11434/v1'), 'http://localhost:11434/v1');
assert.throws(() => baseUrl('custom', 'http://api.example.com/v1'), /https/); // key would go out unencrypted
assert.throws(() => baseUrl('custom', 'file:///etc/passwd'), /https/);
assert.throws(() => baseUrl('custom', ''), /base URL/);
assert.throws(() => baseUrl('anthropic', ''), /Unknown/);
assert.deepEqual(tuning('openai/gpt-oss-120b'), { temperature: 0, reasoning_effort: 'low' });
assert.deepEqual(tuning('gpt-4.1-mini'), { temperature: 0 });
assert.deepEqual(tuning('gpt-5-mini'), {}); // rejects temperature
assert.deepEqual(tuning('openai/o4-mini'), {});

(async () => {
  const ai = { url: 'https://api.test/v1', key: 'k', chatModel: 'chat-x', transcribeModel: 'whisper-1' };
  await new Promise((r) => setTimeout(r, 50)); // let the pipeline test above finish with its own fetch stub
  global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'chat-x' }, { id: 'whisper-1' }] }) });
  await checkAi(ai);
  await assert.rejects(checkAi({ ...ai, chatModel: 'typo' }), /typo/);
  global.fetch = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', headers: new Map(), json: async () => ({ error: { message: 'Invalid API Key' } }) });
  await assert.rejects(checkAi(ai), /api\.test 401: Invalid API Key/);
  global.fetch = async () => ({ ok: true, json: async () => ({ text: 'no timestamps here' }) });
  await assert.rejects(transcribe({ ...ai, transcribeModel: 'gpt-4o-transcribe' }, wav, () => {}, 1), /no timestamps/);
  console.log('ai provider settings ok');
})();
