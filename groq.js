const { wavHeader } = require('./wav');

// Any OpenAI-compatible API that has both /audio/transcriptions (Whisper) and /chat/completions.
// ai = { url, key, chatModel, transcribeModel }, set in Settings.
const PRESETS = {
  groq: { url: 'https://api.groq.com/openai/v1', chatModel: 'openai/gpt-oss-120b', transcribeModel: 'whisper-large-v3' },
  openai: { url: 'https://api.openai.com/v1', chatModel: 'gpt-4.1-mini', transcribeModel: 'whisper-1' },
};
const RATE = 16000;
const CHUNK_SEC = 600; // 10 min of 16 kHz 16-bit mono = 19 MB, under the 25 MB upload limit of Groq and OpenAI
const SEARCH_SEC = 10; // look this far back from each cut for a pause
const WIN = RATE / 10; // 100 ms loudness windows

// Sample offsets where to cut long audio: at the quietest 100 ms just before each 10-min mark.
function splitPoints(pcm, chunkSec = CHUNK_SEC, searchSec = SEARCH_SEC) {
  const points = [];
  let start = 0;
  while (pcm.length - start > chunkSec * RATE) {
    const target = start + chunkSec * RATE;
    let best = target;
    let bestEnergy = Infinity;
    // never search before the current chunk's start, or the cut could fail to advance
    for (let w = Math.max(start + WIN, target - searchSec * RATE); w + WIN <= target; w += WIN) {
      let e = 0;
      for (let i = w; i < w + WIN; i++) e += pcm[i] * pcm[i];
      if (e < bestEnergy) { bestEnergy = e; best = w + WIN / 2; }
    }
    points.push(best);
    start = best;
  }
  return points;
}

async function api(ai, path, init = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ai.url + path, { ...init, headers: { Authorization: `Bearer ${ai.key}`, ...init.headers } });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === 4) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`${new URL(ai.url).hostname} ${res.status}: ${body.error?.message || res.statusText}`);
    }
    const wait = Number(res.headers.get('retry-after')) || 2 ** attempt * 5;
    await new Promise((r) => setTimeout(r, Math.min(wait, 120) * 1000));
  }
}

// OpenAI reasoning models (gpt-5, o-series) reject temperature; only gpt-oss takes reasoning_effort here.
// shortcut: model quirks matched by name, add a pattern when a provider rejects a parameter.
const tuning = (model) => ({
  ...(/(^|\/)(gpt-5|o\d)/.test(model) ? {} : { temperature: 0 }),
  ...(/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}),
});

const chat = (ai, system, user, extra = {}) =>
  api(ai, '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ai.chatModel,
      ...tuning(ai.chatModel),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...extra,
    }),
  }).then((d) => {
    const out = d.choices?.[0]?.message?.content;
    if (!out) throw new Error('The AI returned an empty response.');
    return out.trim();
  });

const ROMANIZE = 'Transliterate the meeting transcript (lines may start with a "[mm:ss] You:" or "[mm:ss] Others:" label: copy labels exactly) into Roman-script Hinglish, the way Indians type Hindi in chats (e.g. "kal tak deploy kar dena"). Rules: convert every Devanagari word to Roman letters; when a Devanagari word is actually an English word (e.g. मीटिंग, थैंक यू) write it in normal English spelling (meeting, thank you); leave words already in Roman letters exactly as they are; do not translate, summarize, correct, add or remove anything; keep punctuation and line breaks. Output only the transliterated text.';
const DEVANAGARI = /[ऀ-ॿ]/;

const romanize = (ai, text) => (DEVANAGARI.test(text) ? chat(ai, ROMANIZE, text) : text);


const SPEECH_RMS = 150; // 100 ms window louder than this counts as sound; silence/noise floor is well below

// RMS of the loudest 100 ms window in pcm[from, to). Used to skip silent audio, where Whisper
// tends to hallucinate filler ("Thank you.", "सब्सक्राइब करें").
function peakRms(pcm, from = 0, to = pcm.length) {
  let peak = 0;
  for (let w = from; w < to; w += WIN) {
    let e = 0;
    const end = Math.min(w + WIN, to);
    for (let i = w; i < end; i++) e += pcm[i] * pcm[i];
    peak = Math.max(peak, Math.sqrt(e / (end - w)));
  }
  return peak;
}

// First sample of the first 100 ms window in [from, to) that has sound (to if none).
function firstSound(pcm, from, to) {
  for (let w = from; w < to; w += WIN) if (peakRms(pcm, w, Math.min(w + WIN, to)) >= SPEECH_RMS) return w;
  return to;
}

// Words Whisper (Hindi mode) invents over beeps, breathing and room noise. A segment made
// only of these is dropped; real sentences that merely contain them are kept.
const FILLER = new Set(['झाल', 'jhal', 'अजय', 'ajay', 'को', 'ko', 'कि', 'ki', 'अ', 'a', 'कर', 'kar', 'दो', 'do', 'हम्म', 'hmm', 'उम', 'um']);

// Measured on a real recording: invented segments scored no_speech_prob 0.79-0.87, real speech 0.55-0.73.
const isHallucination = (seg) =>
  seg.no_speech_prob > 0.75 ||
  seg.compression_ratio > 2.4 || // degenerate repeated output
  seg.avg_logprob < -1.5 ||
  words(seg.text).every((w) => FILLER.has(w));

// Interleaved PCM -> one Int16Array per channel. We record mic ("You"), call (system) audio, bot.
function deinterleave(pcm, n = 2) {
  const out = Array.from({ length: n }, () => new Int16Array(Math.floor(pcm.length / n)));
  for (let i = 0; i < out[0].length; i++) for (let c = 0; c < n; c++) out[c][i] = pcm[n * i + c];
  return out;
}

// The bot hears the call straight from Meet (no system sounds, no speaker echo), so use it from its
// first to its last sound and the system audio elsewhere (before it was let in, after it left).
// shortcut: one bot span per recording; a bot that drops out mid-call leaves a silent gap until it ends.
function preferBot(call, bot) {
  const first = firstSound(bot, 0, bot.length);
  if (first === bot.length) return call;
  let last = bot.length;
  while (last - WIN > first && peakRms(bot, last - WIN, last) < SPEECH_RMS) last -= WIN;
  const out = call.slice();
  out.set(bot.subarray(first, last), first);
  return out;
}

// \p{M} keeps Devanagari vowel signs (the ो in को), which are marks, not letters.
const words = (t) => t.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

const overlap = (a, b) => {
  const heard = new Set(words(b));
  const mine = words(a);
  return mine.filter((w) => heard.has(w)).length / Math.max(mine.length, 1) >= 0.6;
};

// The same words on both sides: either your mic heard the speakers (drop the "You" copy) or the bot
// heard you (drop the "Others" copy). Meet never plays your own voice back to you, so if the call
// (system) audio was silent at that moment, it was you. No call audio given: assume echo.
function dropEcho(segments, call) {
  const drop = new Set();
  const others = segments.filter((s) => s.speaker === 'Others');
  for (const s of segments.filter((x) => x.speaker === 'You')) {
    const near = others.filter((o) => o.start < s.end + 1 && o.end > s.start - 1);
    if (!near.length || !overlap(s.text, near.map((o) => o.text).join(' '))) continue;
    if (!call || peakRms(call, Math.floor(s.start * RATE), Math.ceil(s.end * RATE)) >= SPEECH_RMS) drop.add(s);
    else near.filter((o) => overlap(o.text, s.text)).forEach((o) => drop.add(o));
  }
  return segments.filter((s) => !drop.has(s));
}

const clock = (sec) => {
  const t = Math.floor(sec);
  const hms = [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map((n) => String(n).padStart(2, '0'));
  return t >= 3600 ? hms.join(':') : hms.slice(1).join(':');
};

// Time-ordered "[mm:ss] You: …" lines; consecutive lines by the same speaker are merged.
function formatTranscript(segments) {
  const lines = [];
  let last = null;
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    if (last && last.speaker === s.speaker) last.text += ` ${s.text}`;
    else lines.push((last = { ...s }));
  }
  return lines.map((l) => (l.speaker ? `[${clock(l.start)}] ${l.speaker}: ${l.text}` : l.text)).join('\n\n');
}

// Transcribe one mono channel in ~10 min pieces; returns timed segments.
async function transcribeChannel(ai, pcm, speaker, onProgress, chunkSec) {
  const bounds = [0, ...splitPoints(pcm, chunkSec), pcm.length];
  const out = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const [from, to] = [bounds[i], bounds[i + 1]];
    if (peakRms(pcm, from, to) < SPEECH_RMS) continue; // silent piece (e.g. no call audio)
    onProgress(`Transcribing ${speaker ? `${speaker} ` : ''}part ${i + 1} of ${bounds.length - 1}…`);
    const slice = Buffer.from(pcm.buffer, pcm.byteOffset + from * 2, (to - from) * 2);
    const form = new FormData();
    form.append('file', new Blob([wavHeader(slice.length), slice], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', ai.transcribeModel);
    form.append('language', 'hi'); // handles English + Hindi + mixed; stops Hindi being misdetected as Urdu
    form.append('temperature', '0');
    // No style prompt: Whisper copied it into the transcript over quiet audio ("Okay, aaj ka agenda hai?").
    form.append('response_format', 'verbose_json');
    const { segments } = await api(ai, '/audio/transcriptions', { method: 'POST', body: form });
    // gpt-4o-transcribe and similar return text without timestamps: speakers and times would be lost
    if (!Array.isArray(segments)) throw new Error(`${ai.transcribeModel} returns no timestamps. Use a Whisper model (whisper-large-v3, whisper-1).`);
    for (const seg of segments) {
      const text = seg.text.trim();
      const b = Math.min(to, from + Math.ceil(seg.end * RATE));
      // Whisper often starts a segment at the beginning of the silence before it; snap to the sound.
      const a = firstSound(pcm, from + Math.floor(seg.start * RATE), b);
      if (!text || a >= b || isHallucination(seg)) continue; // invented over silence/noise
      out.push({ speaker, start: a / RATE, end: b / RATE, text });
    }
  }
  return out;
}

// Romanize in blocks of whole lines so "[mm:ss] You:" prefixes stay intact.
async function romanizeLines(ai, text, onProgress) {
  const blocks = [];
  for (const line of text.split('\n\n')) {
    const cur = blocks[blocks.length - 1];
    if (cur && cur.length + line.length < 6000) blocks[blocks.length - 1] = `${cur}\n\n${line}`;
    else blocks.push(line);
  }
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    onProgress(`Converting to Roman Hinglish (${i + 1}/${blocks.length})…`);
    out.push(await romanize(ai, blocks[i]));
  }
  return out.join('\n\n');
}

// wav: Buffer of a 16 kHz 16-bit WAV we wrote: mic ("You"), call audio ("Others"), and since the
// note-taker bot a third channel with the bot's audio. Old mono recordings get no speaker labels.
// Returns { raw, text } (raw keeps Devanagari).
async function transcribe(ai, wav, onProgress = () => {}, chunkSec = CHUNK_SEC) {
  const channels = wav.readUInt16LE(22);
  const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) >> 1);
  let segments;
  if (channels >= 2) {
    const [mic, call, bot] = deinterleave(pcm, channels);
    segments = dropEcho([
      ...(await transcribeChannel(ai, mic, 'You', onProgress, chunkSec)),
      ...(await transcribeChannel(ai, bot ? preferBot(call, bot) : call, 'Others', onProgress, chunkSec)),
    ], call);
  } else {
    segments = await transcribeChannel(ai, pcm, null, onProgress, chunkSec);
  }
  const raw = formatTranscript(segments);
  return { raw, text: await romanizeLines(ai, raw, onProgress) };
}

// Structured Minutes of Meeting (validated by mom.normalizeMom).
const mom = require('./mom');
const minutes = async (ai, transcript, meetingDate) =>
  mom.normalizeMom(await chat(ai, mom.PROMPT(meetingDate), `<transcript>\n${transcript}\n</transcript>`, {
    response_format: { type: 'json_schema', json_schema: { name: 'minutes_of_meeting', strict: true, schema: mom.SCHEMA } },
  }));

// Settings check before saving: the key works and both models exist (when the provider lists models).
async function checkAi(ai) {
  const { data } = await api(ai, '/models');
  const ids = new Set((data || []).map((m) => m.id));
  const missing = [ai.chatModel, ai.transcribeModel].filter((m) => ids.size && !ids.has(m));
  if (missing.length) throw new Error(`Not available with this key: ${missing.join(', ')}`);
}

// API base URL for a provider; the key is sent there, so plain http only to this Mac (Ollama, LM Studio).
function baseUrl(provider, url) {
  if (PRESETS[provider]) return PRESETS[provider].url;
  if (provider !== 'custom') throw new Error('Unknown provider.');
  let u;
  try { u = new URL(String(url).trim()); } catch { throw new Error('Enter the API base URL, e.g. https://api.example.com/v1'); }
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new Error('The base URL must start with https://');
  return u.href.replace(/\/+$/, '');
}

module.exports = { PRESETS, baseUrl, checkAi, tuning, isHallucination, minutes, splitPoints, peakRms, firstSound, deinterleave, preferBot, dropEcho, formatTranscript, transcribe };
