const { app, BrowserWindow, ipcMain, session, desktopCapturer, shell, safeStorage, systemPreferences, clipboard, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { wavHeader } = require('./wav');
const { isMeetingApp } = require('./meeting');
const groq = require('./groq');
const bot = require('./bot');
const { parseMeetingLink } = require('./meeting-link');
const { momToMarkdown, momToHtml } = require('./mom');
const { currentEvent, fetchCalendar } = require('./calendar');

// Lets getDisplayMedia return system audio on macOS (ScreenCaptureKit loopback).
app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');

// Older setups keep the Groq key in a git-ignored .env; used until an AI provider is saved in Settings.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}
const CHANNELS = 3; // mic | call (system) audio | note-taker bot
const ID_RE = /^[0-9TZ-]+$/; // ids come from the renderer: only our own timestamp format is allowed

let dir; // recordings folder
let current = null; // { id, fd, bytes }

const file = (id, ext) => {
  if (!ID_RE.test(id)) throw new Error('bad id');
  return path.join(dir, `${id}.${ext}`);
};

let mainWin = null;

function createWindow() {
  const win = (mainWin = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Meeting Notes',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  }));
  // Not window-all-closed: the hidden bot window can outlive this one, and the recording lives here.
  win.on('closed', () => { if (current) finishRecording(); });
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  dir = path.join(app.getPath('userData'), 'recordings');
  fs.mkdirSync(dir, { recursive: true });

  // getDisplayMedia from the renderer -> whole screen + loopback system audio, or the bot's page after bot:capture.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    if (captureBot) {
      captureBot = false;
      const f = bot.frame();
      return callback(f ? { video: f, audio: f } : {});
    }
    const [screen] = await desktopCapturer.getSources({ types: ['screen'] });
    callback({ video: screen, audio: 'loopback' });
  });

  createWindow();
  app.on('activate', () => (mainWin && !mainWin.isDestroyed()) || createWindow()); // hidden bot window doesn't count
  watchMeetings();
  refreshCalendar();
  setInterval(refreshCalendar, CAL_REFRESH_MS);
});

const END_GRACE_MS = 15000; // mic can drop briefly (mute, device switch) without ending the meeting
let meetingApps = [];
let endTimer = null;
let micMuted = false; // muted in the meeting app: the renderer records silence on the mic channel
let captureBot = false;

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

function watchMeetings() {
  const bin = path.join(__dirname, 'bin', 'mic-watch').replace('app.asar', 'app.asar.unpacked'); // packaged: binaries can't run from inside the asar
  if (process.platform !== 'darwin') return; // mic-watch is a macOS-only helper
  if (!fs.existsSync(bin)) return console.warn('mic-watch not built; run `npm run build:watcher`');
  const child = spawn(bin, [], { stdio: ['ignore', 'pipe', 'inherit'] });
  app.on('will-quit', () => child.kill());
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let apps, muted;
    try { ({ apps, muted } = JSON.parse(line)); apps = apps.filter(isMeetingApp); } catch { return; }
    const nowMuted = Object.entries(muted).some(([b, m]) => m && isMeetingApp(b));
    if (nowMuted !== micMuted) broadcast('mic:muted', (micMuted = nowMuted));
    if (apps.length || micMuted) { // some apps release the mic while muted: still in the meeting
      clearTimeout(endTimer);
      endTimer = null;
      if (!meetingApps.length && apps.length) broadcast('meeting:start', { apps, event: cal && currentEvent(cal), calendar: !!cal });
      if (apps.length) meetingApps = apps;
    } else if (meetingApps.length && !endTimer) {
      endTimer = setTimeout(() => {
        meetingApps = [];
        endTimer = null;
        broadcast('meeting:end');
      }, END_GRACE_MS);
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
// Cmd+Q skips window-all-closed, so patch the WAV header here too.
app.on('will-quit', () => current && finishRecording());

function finishRecording() {
  const { id, fd, bytes } = current;
  fs.writeSync(fd, wavHeader(bytes, 16000, CHANNELS), 0, 44, 0); // patch header now that size is known
  fs.closeSync(fd);
  current = null;
  bot.stop();
  return id;
}

ipcMain.handle('rec:start', (_e, title) => {
  if (current) finishRecording(); // a renderer reload orphaned it; the renderer's button blocks real double starts
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  if (typeof title === 'string' && title.trim()) fs.writeFileSync(file(id, 'json'), JSON.stringify({ title: title.trim().slice(0, 200) }));
  const fd = fs.openSync(file(id, 'wav'), 'w');
  fs.writeSync(fd, wavHeader(0, 16000, CHANNELS)); // placeholder
  current = { id, fd, bytes: 0 };
  return id;
});

ipcMain.on('rec:chunk', (_e, buf) => {
  if (!current) return;
  const b = Buffer.from(buf);
  fs.writeSync(current.fd, b);
  current.bytes += b.length;
});

ipcMain.handle('rec:stop', () => (current ? finishRecording() : null));

ipcMain.handle('transcribe', async (e, id) => {
  const { text, raw } = await groq.transcribe(aiConfig(), fs.readFileSync(file(id, 'wav')), (msg) => e.sender.send('status', msg));
  fs.writeFileSync(file(id, 'raw.txt'), raw); // Whisper's original (Devanagari) output, kept for checking
  fs.writeFileSync(file(id, 'txt'), text);
  return text;
});

ipcMain.handle('list', () =>
  fs.readdirSync(dir)
    .filter((f) => f.endsWith('.wav'))
    .map((f) => f.slice(0, -4))
    .sort()
    .reverse()
    .map((id) => {
      const mom = readMom(id);
      return {
        id,
        transcribed: fs.existsSync(path.join(dir, `${id}.txt`)),
        hasMom: !!mom,
        title: readTitle(id) || mom?.title || null,
        duration: durationOf(id),
      };
    }));

ipcMain.handle('read', (_e, id) => {
  const read = (ext) => (fs.existsSync(file(id, ext)) ? fs.readFileSync(file(id, ext), 'utf8') : '');
  const mom = readMom(id);
  // summary.md: recordings summarized before Minutes of Meeting existed
  return { transcript: read('txt'), summary: read('summary.md'), mom, title: readTitle(id) || mom?.title || null, duration: durationOf(id) };
});

ipcMain.handle('mom:create', async (_e, id) => {
  const mom = await groq.minutes(aiConfig(), fs.readFileSync(file(id, 'txt'), 'utf8'), meetingDate(id, { weekday: 'long' }));
  fs.writeFileSync(file(id, 'mom.json'), JSON.stringify(mom, null, 2));
  return mom;
});

const momMeta = (id) => ({ date: meetingDate(id), duration: durationOf(id) });
const momOrThrow = (id) => readMom(id) || (() => { throw new Error('Create the minutes first.'); })();

// Copies both rich text (pastes formatted into Gmail/Outlook/Docs) and Markdown (plain-text apps).
ipcMain.handle('mom:copy', (_e, id) => {
  const mom = momOrThrow(id);
  clipboard.write({ text: momToMarkdown(mom, momMeta(id)), html: momToHtml(mom, momMeta(id)) });
});

ipcMain.handle('mom:pdf', async (e, id) => {
  const mom = momOrThrow(id);
  const safeName = mom.title.replace(/[^\w\s.-]/g, '').trim().slice(0, 80) || 'Meeting';
  const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    defaultPath: path.join(app.getPath('documents'), `MOM - ${safeName}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  // Render in a throwaway window with scripts off; the HTML is fully escaped anyway.
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(momToHtml(mom, momMeta(id)))}`);
    fs.writeFileSync(filePath, await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true }));
  } finally {
    win.destroy();
  }
  shell.showItemInFolder(filePath);
  return filePath;
});

function readMom(id) {
  try { return JSON.parse(fs.readFileSync(file(id, 'mom.json'), 'utf8')); } catch { return null; }
}

// Seconds of audio, from the WAV header (works for old mono and new stereo files).
function durationOf(id) {
  try {
    const fd = fs.openSync(file(id, 'wav'), 'r');
    const h = Buffer.alloc(44);
    fs.readSync(fd, h, 0, 44, 0);
    fs.closeSync(fd);
    return h.readUInt32LE(40) / h.readUInt32LE(28);
  } catch { return 0; }
}

// ids are ISO timestamps with ':'/'.' replaced by '-' (UTC); show them in local time.
function meetingDate(id, extra = {}) {
  const iso = id.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3.$4Z');
  return new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', ...extra });
}


ipcMain.handle('reveal', () => shell.openPath(dir));

// Shows the macOS mic prompt if never asked; returns false when the user has turned it off.
ipcMain.handle('media:prepare', async () => ({
  mic: process.platform !== 'darwin' || (await systemPreferences.askForMediaAccess('microphone')),
  screen: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
}));

const PRIVACY_PANES = { microphone: 'Privacy_Microphone', screen: 'Privacy_ScreenCapture' };
ipcMain.handle('media:settings', (_e, kind) =>
  PRIVACY_PANES[kind] && shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES[kind]}`));

// Re-validated here: the renderer is not trusted to decide what the OS opens.
ipcMain.handle('meeting:open', async (_e, link) => {
  const m = parseMeetingLink(link);
  await shell.openExternal(m.url);
  if (m.platform === 'Google Meet') bot.start(m.url, (state) => broadcast('bot:state', state));
  const event = cal && currentEvent(cal);
  return { ...m, title: event?.title || m.title };
});

ipcMain.handle('mic:muted', () => micMuted);
ipcMain.handle('bot:capture', () => { captureBot = true; }); // the next getDisplayMedia records the bot
ipcMain.handle('bot:signin', () => bot.signIn());

function readTitle(id) {
  try { return JSON.parse(fs.readFileSync(file(id, 'json'), 'utf8')).title; } catch { return null; }
}

// --- Calendar (secret iCal link from Google Calendar / Outlook) ---
const CAL_REFRESH_MS = 5 * 60 * 1000;
let cal = null; // parsed calendar, null when not configured
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } };
const writeSettings = (patch) => fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }), { mode: 0o600 });
// Secrets (iCal link, API key) are encrypted at rest with the macOS keychain.
const encrypt = (t) => (t ? safeStorage.encryptString(t).toString('base64') : '');
const decrypt = (t) => { try { return t ? safeStorage.decryptString(Buffer.from(t, 'base64')) : ''; } catch { return ''; } };

// The iCal link is a secret: anyone with it can read the calendar.
const loadCalendarUrl = () => decrypt(readSettings().calendarUrl);
const saveCalendarUrl = (url) => writeSettings({ calendarUrl: encrypt(url) });

async function refreshCalendar() {
  const url = loadCalendarUrl();
  if (!url) return void (cal = null);
  try { cal = await fetchCalendar(url); } catch (e) { console.warn('calendar refresh failed:', e.message); } // keep last good copy
}

ipcMain.handle('calendar:get', () => ({ configured: !!loadCalendarUrl(), now: cal && currentEvent(cal) }));

ipcMain.handle('calendar:set', async (_e, url) => {
  if (!url) { saveCalendarUrl(''); cal = null; return { configured: false, now: null }; }
  const parsed = await fetchCalendar(url); // validate before saving; throws with a readable message
  saveCalendarUrl(url.trim());
  cal = parsed;
  return { configured: true, now: currentEvent(cal) };
});

// --- AI provider (Settings) ---
function aiConfig() {
  const s = readSettings().ai || {};
  const preset = groq.PRESETS[s.provider] || groq.PRESETS.groq;
  const key = s.provider ? decrypt(s.apiKey) : process.env.GROQ_API_KEY || '';
  if (!key) throw new Error('Add your API key in Settings › AI provider.');
  return { url: s.url || preset.url, key, chatModel: s.chatModel || preset.chatModel, transcribeModel: s.transcribeModel || preset.transcribeModel };
}

// The key never goes back to the renderer, only whether one is saved.
ipcMain.handle('ai:get', () => {
  const s = readSettings().ai || {};
  const provider = s.provider || 'groq';
  return { presets: groq.PRESETS, provider, url: s.url || '', chatModel: s.chatModel || '', transcribeModel: s.transcribeModel || '',
    hasKey: s.provider ? !!decrypt(s.apiKey) : !!process.env.GROQ_API_KEY };
});

ipcMain.handle('ai:set', async (_e, input) => {
  const { provider, url = '', apiKey = '', chatModel = '', transcribeModel = '' } = input || {};
  const preset = groq.PRESETS[provider];
  const base = groq.baseUrl(provider, url);
  const old = readSettings().ai || {};
  const sameProvider = (old.provider || 'groq') === provider && (old.url || '') === (preset ? '' : base);
  const key = String(apiKey).trim() || (sameProvider ? (old.provider ? decrypt(old.apiKey) : process.env.GROQ_API_KEY) : '');
  if (!key) throw new Error('Enter the API key for this provider.');
  const ai = { url: base, key, chatModel: String(chatModel).trim() || preset?.chatModel || '', transcribeModel: String(transcribeModel).trim() || preset?.transcribeModel || '' };
  if (!ai.chatModel || !ai.transcribeModel) throw new Error('Enter both model names.');
  await groq.checkAi(ai); // throws with the provider's message on a bad key or model
  writeSettings({ ai: { provider, url: preset ? '' : base, apiKey: encrypt(key), chatModel: ai.chatModel, transcribeModel: ai.transcribeModel } });
});
