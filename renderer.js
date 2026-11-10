const $ = (id) => document.getElementById(id);
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Builds DOM with textContent only: transcript and minutes text never become HTML.
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...children.flat().filter((c) => c != null && c !== false && c !== ''));
  return n;
}

const when = (id) => {
  const iso = id.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3.$4Z');
  return new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const mins = (sec) => {
  const m = Math.round(sec / 60);
  return m < 60 ? `${Math.max(m, 1)} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const clock = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// ---------- Status ----------
let statusTimer;
function status(text, kind = 'busy') {
  clearTimeout(statusTimer);
  $('status').className = `status ${text ? 'show' : ''} ${kind}`;
  $('statusText').textContent = text || '';
  if (text && kind === 'idle') statusTimer = setTimeout(() => status(''), 6000);
}
window.api.onStatus((msg) => status(msg));

// ---------- Recording ----------
let session = null; // active recording
let selected = null;
let recTick = null;

async function startRecording(title) {
  // Ask macOS first: a denied mic otherwise surfaces only as a bare "Permission denied".
  const perm = await window.api.prepareMedia();
  if (!perm.mic) window.api.openPrivacySettings('microphone');

  const ctx = new AudioContext(); // native rate; the worklet downsamples to 16 kHz itself
  const streams = [];
  try {
    await openStreams(ctx, streams, perm, title);
  } catch (e) {
    // otherwise the mic (and screen capture) stay live after a failed start
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    ctx.close();
    throw e;
  }
}

async function openStreams(ctx, streams, perm, title) {
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  // Mono inputs kept apart (mic, call, bot) so the transcript can say who spoke, and so each
  // source keeps recording when another one fails.
  const writer = new AudioWorkletNode(ctx, 'pcm-writer', {
    numberOfInputs: 3,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
  });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  writer.connect(mute).connect(ctx.destination); // keeps the node pulled by the audio graph, silently
  // Low-pass below 8 kHz before the worklet's 16 kHz downsampling, so nothing aliases.
  const into = (stream, input) => {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 7000;
    ctx.createMediaStreamSource(stream).connect(lp).connect(writer, 0, input);
  };
  writer.port.postMessage({ muted: await window.api.isMicMuted() });

  const notes = [];
  try {
    if (!perm.mic) throw new Error('off');
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
    streams.push(mic);
    into(mic, 0);
  } catch {
    notes.push(perm.mic ? 'No microphone found' : 'Microphone access is off (System Settings › Privacy & Security › Microphone, turn on "Electron")');
  }

  if ($('sys').checked) {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      display.getVideoTracks().forEach((t) => t.stop()); // only want the audio
      if (display.getAudioTracks().length) {
        streams.push(display);
        into(display, 1);
      } else notes.push('No call audio found');
    } catch {
      if (perm.screen !== 'granted') window.api.openPrivacySettings('screen');
      notes.push('Call audio is blocked (System Settings › Privacy & Security › Screen & System Audio Recording, turn on "Electron", then restart the app)');
    }
  }

  const id = await window.api.start(title);
  writer.port.onmessage = (e) => window.api.chunk(e.data);
  session = { ctx, writer, streams, into, id, started: Date.now(), title };
  if (notes.length) status(`${notes.join('. ')}. Recording what is available.`, 'error');
}

async function stopRecording() {
  const { ctx, writer, streams } = session;
  session = null;
  writer.port.postMessage('flush');
  await new Promise((r) => setTimeout(r, 100)); // let the final chunk arrive
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  await ctx.close();
  return window.api.stop();
}

function showRecording(on) {
  const btn = $('rec');
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-label', on ? 'Stop recording' : 'Start recording');
  clearInterval(recTick);
  if (on) {
    $('recSub').textContent = recSubText();
    const tick = () => { $('recLabel').textContent = clock((Date.now() - session.started) / 1000); };
    tick();
    recTick = setInterval(tick, 500);
  } else {
    $('recLabel').textContent = 'Start recording';
    $('recSub').textContent = 'Records your mic and the call audio';
  }
}

async function toggle(title) {
  const btn = $('rec');
  if (btn.disabled) return; // a start/stop is already in flight
  btn.disabled = true;
  try {
    if (!session) {
      await startRecording(title);
      showRecording(true);
    } else {
      const id = await stopRecording();
      showRecording(false);
      await refresh();
      await select(id);
      processRecording(id); // transcribe, then write the minutes
    }
  } catch (e) {
    status(cleanErr(e), 'error');
  } finally {
    btn.disabled = false;
  }
}

$('rec').onclick = () => {
  autoStarted = false; // manual start/stop: never auto-stop it
  toggle();
};

// ---------- Transcribe + minutes ----------
const busy = new Set(); // recording ids being processed

async function job(id, fn, label) {
  if (busy.has(id)) return false;
  busy.add(id);
  status(label);
  renderList();
  if (selected === id) render(); // show disabled buttons
  try {
    await fn();
    return true;
  } catch (e) {
    status(cleanErr(e), 'error');
    return false;
  } finally {
    busy.delete(id);
    await refresh();
    if (selected === id) await select(id);
  }
}

async function processRecording(id) {
  if (!(await job(id, () => window.api.transcribe(id), 'Transcribing…'))) return;
  if (await job(id, () => window.api.createMom(id), 'Writing minutes of meeting…')) status('Minutes ready', 'idle');
}

// ---------- List ----------
let recordings = [];

async function refresh() {
  recordings = await window.api.list();
  renderList();
}

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const shown = recordings.filter((r) => !q || `${r.title || ''} ${when(r.id)}`.toLowerCase().includes(q));
  $('count').textContent = recordings.length || '';
  const badge = (r) => (busy.has(r.id) ? ['acc', 'Processing'] : r.hasMom ? ['ok', 'Minutes'] : r.transcribed ? ['', 'Transcript'] : ['', 'Audio only']);
  $('list').replaceChildren(...(shown.length
    ? shown.map((r) => el('li', {}, el('button', { 'aria-current': String(r.id === selected), onclick: () => select(r.id) },
      el('span', { class: 'item-title', text: r.title || 'Untitled meeting' }),
      el('span', { class: 'item-meta' },
        el('span', { text: `${when(r.id)} · ${mins(r.duration)}` }),
        el('span', { class: `badge ${badge(r)[0]}`, text: badge(r)[1] })))))
    : [el('li', { class: 'empty-list', text: q ? 'No matching recordings' : 'No recordings yet' })]));
}
$('search').oninput = renderList;

// ---------- Detail ----------
let data = null; // { transcript, summary, mom, title, duration } for the selected recording
let tab = 'mom';

async function select(id) {
  selected = id;
  data = await window.api.read(id);
  renderList();
  render();
}

function render() {
  $('empty').hidden = !!selected;
  $('detail').hidden = !selected;
  if (!selected || !data) return;
  const working = busy.has(selected);
  $('title').textContent = data.title || 'Untitled meeting';
  $('date').textContent = when(selected);
  $('dur').textContent = mins(data.duration);
  $('momActions').hidden = !data.mom;
  for (const [t, btn, pane] of [['mom', 'tabMom', 'momPane'], ['tx', 'tabTx', 'txPane']]) {
    $(btn).setAttribute('aria-selected', String(tab === t));
    $(pane).hidden = tab !== t;
  }
  $('momPane').replaceChildren(...renderMom(working).filter(Boolean));
  $('txPane').replaceChildren(...renderTranscript(working));
}

$('tabMom').onclick = () => { tab = 'mom'; render(); };
$('tabTx').onclick = () => { tab = 'tx'; render(); };

const card = (title, ...body) => el('div', { class: 'card' }, el('h3', { text: title }), ...body);
const btn = (props, text, onclick, working) => el('button', { ...props, ...(working ? { disabled: '' } : {}), onclick, text });

function renderMom(working) {
  const id = selected;
  const m = data.mom;
  if (!m) {
    const canMake = !!data.transcript;
    return [
      el('div', { class: 'card cta' },
        el('h2', { text: working ? 'Working on it…' : 'Minutes of Meeting' }),
        el('p', { text: working ? 'This takes a moment for long meetings.'
          : canMake ? 'Turn the transcript into a summary, decisions and action items.'
          : 'Transcribe the recording first, then create the minutes.' }),
        btn({ class: 'primary' }, canMake ? 'Create minutes' : 'Transcribe & create minutes',
          () => (canMake ? job(id, () => window.api.createMom(id), 'Writing minutes of meeting…') : processRecording(id)), working)),
      data.summary && card('Earlier summary', el('div', { class: 'legacy', text: data.summary })),
    ];
  }

  const bullets = (items, cls) => el('ul', cls ? { class: cls } : {}, items.map((t) => el('li', { text: t })));
  const none = (t) => el('span', { class: 'none', text: t });
  return [
    m.summary && el('div', { class: 'card summary' }, el('h3', { text: 'Summary' }), el('div', { text: m.summary })),
    card('Agenda', m.agenda.length ? el('ol', {}, m.agenda.map((a) => el('li', { text: a }))) : none('Not mentioned')),
    m.discussion.length && card('Discussion', m.discussion.map((d) => el('div', { class: 'topic' }, el('b', { text: d.topic }), bullets(d.points)))),
    m.decisions.length && card('Decisions', bullets(m.decisions, 'checks')),
    card('Action items', m.action_items.length
      ? el('table', {},
        el('thead', {}, el('tr', {}, ['#', 'Task', 'Owner', 'Due'].map((h) => el('th', { text: h })))),
        el('tbody', {}, m.action_items.map((a, i) => el('tr', {},
          el('td', { class: 'none', text: String(i + 1) }),
          el('td', { text: a.task }),
          el('td', {}, a.owner ? el('span', { class: 'owner', text: a.owner }) : none('Unassigned')),
          el('td', { class: 'due', text: a.due || '—' })))))
      : none('No action items')),
    m.next_steps.length && card('Next steps', bullets(m.next_steps)),
    el('div', { class: 'regen' }, btn({ class: 'ghost' }, 'Regenerate minutes',
      () => job(id, () => window.api.createMom(id), 'Rewriting minutes of meeting…'), working)),
  ];
}

const LINE = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\] (You|Others): ([\s\S]*)$/;

function renderTranscript(working) {
  const id = selected;
  const redo = el('div', { class: 'regen' }, btn({ class: 'ghost' }, data.transcript ? 'Transcribe again' : 'Transcribe',
    () => job(id, () => window.api.transcribe(id), 'Transcribing…'), working));
  if (!data.transcript) {
    return [el('div', { class: 'card cta' }, el('h2', { text: working ? 'Transcribing…' : 'No transcript yet' }),
      el('p', { text: 'English, Hindi and Hinglish are supported.' }), redo)];
  }
  const turns = data.transcript.split('\n\n').map((block) => {
    const m = block.match(LINE);
    if (!m) return el('div', { class: 'plain', text: block });
    const [, ts, who, text] = m;
    return el('div', { class: `turn ${who.toLowerCase()}` },
      el('div', { class: 'avatar', text: who === 'You' ? 'Y' : 'O', 'aria-hidden': 'true' }),
      el('div', {}, el('span', { class: 'who', text: who }), el('span', { class: 'ts', text: ts }), el('div', { text })));
  });
  return [el('div', { class: 'transcript' }, turns), redo];
}

$('copy').onclick = async () => {
  try {
    await window.api.copyMom(selected);
    status('Minutes copied: paste into email, Docs or Slack', 'idle');
  } catch (e) { status(cleanErr(e), 'error'); }
};
$('pdf').onclick = async () => {
  try {
    if (await window.api.exportMomPdf(selected)) status('PDF saved', 'idle');
  } catch (e) { status(cleanErr(e), 'error'); }
};

// ---------- Join by link ----------
$('joinform').onsubmit = async (e) => {
  e.preventDefault();
  if (session) return status('Already recording. Stop first to join another meeting.', 'error');
  try {
    const m = await window.api.openMeeting($('link').value);
    $('link').value = '';
    status(`Opening ${m.platform}…`, 'idle');
    await startForMeeting(m.title);
  } catch (err) {
    status(cleanErr(err), 'error');
  }
};

// ---------- Meeting auto-detect ----------
let autoStarted = false;
try { $('auto').checked = localStorage.getItem('auto') === '1'; } catch {}
$('auto').onchange = () => { try { localStorage.setItem('auto', $('auto').checked ? '1' : '0'); } catch {} };

const appName = (b) => b.split('.').pop();

async function startForMeeting(title) {
  if (session) return;
  await toggle(title);
  autoStarted = !!session;
}

window.api.onMeetingStart(({ apps, event, calendar }) => {
  if (session) return;
  const who = apps.map(appName).join(', ');
  const title = event?.title;
  // With a calendar connected, mic use outside a scheduled event (dictation, voice notes) only notifies.
  if ($('auto').checked && (!calendar || event)) {
    status(`${title ? `"${title}"` : `Meeting (${who})`} detected, recording`, 'idle');
    startForMeeting(title);
  } else {
    const n = new Notification(title ? `"${title}" is starting` : 'Meeting detected', {
      body: `${who} is using the mic. Click to record.`,
    });
    n.onclick = () => startForMeeting(title);
  }
});

window.api.onMeetingEnd(() => {
  if (session && autoStarted) {
    autoStarted = false;
    status('Meeting ended, stopping…');
    toggle();
  }
});

// ---------- Mute + note-taker bot ----------
const recSubText = () => (session.title ? `Recording "${session.title}"` : 'Recording · click to stop');

window.api.onMicMuted((muted) => {
  if (!session) return;
  session.writer.port.postMessage({ muted });
  $('recSub').textContent = muted ? 'Muted in the meeting: your mic is not recorded' : recSubText();
});

const BOT_STATUS = {
  waiting: ['Notetaker is asking to join: let it in from the meeting', 'idle'],
  denied: ['Notetaker was not let in. Recording continues on this Mac.', 'error'],
  timeout: ['Nobody let the Notetaker in. Recording continues on this Mac.', 'error'],
  ended: ['Notetaker left: the meeting ended', 'idle'],
};

window.api.onBotState(async (state) => {
  if (BOT_STATUS[state]) return status(...BOT_STATUS[state]);
  if (state !== 'joined' || !session) return;
  try {
    await window.api.captureBot();
    const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    s.getVideoTracks().forEach((t) => t.stop());
    if (!s.getAudioTracks().length || !session) throw new Error('no audio');
    session.streams.push(s);
    session.into(s, 2);
    status('Notetaker joined and is recording the call', 'idle');
  } catch (e) {
    status(`Notetaker joined, but its audio could not be recorded (${cleanErr(e)}). Recording continues on this Mac.`, 'error');
  }
});
$('botsignin').onclick = () => window.api.botSignIn();

// ---------- Settings ----------
$('settingsBtn').onclick = () => $('settings').showModal();
$('settingsClose').onclick = () => $('settings').close();
$('settings').onclick = (e) => { if (e.target === $('settings')) $('settings').close(); }; // click on backdrop
$('reveal').onclick = () => window.api.reveal();

const calStatus = (t) => ($('calstatus').textContent = t);
const showCal = ({ configured, now }) =>
  calStatus(!configured ? 'Not connected.' : now ? `Connected · now: ${now.title}` : 'Connected · no event right now.');

$('calsave').onclick = async () => {
  calStatus('Checking link…');
  try {
    showCal(await window.api.setCalendar($('calurl').value));
    $('calurl').value = '';
  } catch (e) {
    calStatus(`Could not load calendar: ${cleanErr(e)}`);
  }
};
let ai = null; // { presets, provider, url, chatModel, transcribeModel, hasKey } from main
const showAi = () => {
  const p = $('aiprovider').value;
  const preset = ai.presets[p];
  const saved = p === ai.provider;
  $('aiurlrow').hidden = p !== 'custom';
  $('aikey').placeholder = saved && ai.hasKey ? 'API key saved (leave empty to keep it)' : 'API key';
  $('aichat').placeholder = `Minutes model${preset ? ` (default ${preset.chatModel})` : ''}`;
  $('aiwhisper').placeholder = `Transcription model${preset ? ` (default ${preset.transcribeModel})` : ''}`;
  $('aistatus').textContent = saved && !ai.hasKey ? 'No API key yet: transcription will not work until you add one.' : '';
};
const loadAi = async () => {
  ai = await window.api.getAi();
  $('aiprovider').value = ai.provider;
  $('aiurl').value = ai.url;
  $('aichat').value = ai.chatModel;
  $('aiwhisper').value = ai.transcribeModel;
  $('aikey').value = '';
  showAi();
};
$('aiprovider').onchange = () => { $('aichat').value = ''; $('aiwhisper').value = ''; showAi(); };
$('aisave').onclick = async () => {
  $('aistatus').textContent = 'Checking key and models…';
  try {
    await window.api.setAi({ provider: $('aiprovider').value, url: $('aiurl').value, apiKey: $('aikey').value, chatModel: $('aichat').value, transcribeModel: $('aiwhisper').value });
    await loadAi();
    $('aistatus').textContent = 'Saved.';
  } catch (e) {
    $('aistatus').textContent = cleanErr(e);
  }
};
loadAi();

$('calclear').onclick = async () => showCal(await window.api.setCalendar(''));
window.api.getCalendar().then(showCal);

refresh();
