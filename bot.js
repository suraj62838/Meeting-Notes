// Note-taker bot: a hidden window that joins a Google Meet call as a participant (camera and mic
// off) so its audio can be recorded on its own channel, independent of your mic and system audio.
const { BrowserWindow, session } = require('electron');

const SIGN_IN = 'https://accounts.google.com/ServiceLogin?continue=https://meet.google.com/';
const ADMIT_TIMEOUT_MS = 15 * 60 * 1000;

let ses = null;
function botSession() {
  if (ses) return ses;
  ses = session.fromPartition('persist:notetaker'); // keeps the bot's Google sign-in
  // Google refuses sign-in from browsers that announce Electron; English UI so the labels below match.
  ses.setUserAgent(ses.getUserAgent().replace(/ (Electron|meeting-notes)\/\S+/g, ''), 'en-US');
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)); // never camera or mic
  return ses;
}

// Runs in the Meet page every 2 s: fills the name, clicks through the lobby, reports where it is.
// shortcut: matches Meet's English button labels and messages; update when Meet changes its page.
const STEP = `(() => {
  const text = document.body ? document.body.innerText : '';
  const buttons = [...document.querySelectorAll('button, [role=button]')];
  const find = (re) => buttons.find((b) => re.test((b.getAttribute('aria-label') || b.innerText || '').trim()));
  if (find(/^leave call/i)) return 'joined';
  if (/denied your request|can't join this (video )?call|removed from the (meeting|call)|check your meeting code/i.test(text)) return 'denied';
  if (/you left the (meeting|call)|(meeting|call) has ended|returned to home screen/i.test(text)) return 'ended';
  const name = document.querySelector('input[aria-label*="name" i], input[placeholder*="name" i]');
  if (name && !name.value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(name, 'Notetaker');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const next = find(/^continue without (microphone|mic)/i) || find(/^(ask to join|join now|join anyway)$/i);
  if (next && !next.disabled) next.click();
  return /asking to (be let in|join)|someone in the call (lets|let) you in/i.test(text) ? 'waiting' : 'joining';
})()`;

let win = null;

// onState: 'waiting' | 'joined' | 'denied' | 'ended' | 'timeout' | 'left'
function start(url, onState) {
  stop();
  const w = (win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { session: botSession(), backgroundThrottling: false } }));
  w.webContents.setAudioMuted(true); // its audio is captured directly; playing it too would echo into the other channels
  let state = 'joining';
  const set = (s) => s !== state && onState((state = s));
  const deadline = Date.now() + ADMIT_TIMEOUT_MS;
  const tick = setInterval(async () => {
    let s;
    try { s = await w.webContents.executeJavaScript(STEP, true); } catch { return; } // page still loading
    if (s !== 'joined' && state !== 'joined' && Date.now() > deadline) s = 'timeout';
    if (s === 'joining' && state === 'waiting') return; // lobby re-render between checks
    set(s);
    if (['denied', 'ended', 'timeout'].includes(s)) stop();
  }, 2000);
  w.on('closed', () => {
    clearInterval(tick);
    if (win === w) win = null;
    if (!['denied', 'ended', 'timeout'].includes(state)) set('left');
  });
  w.loadURL(url).catch(() => stop());
}

function stop() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

const frame = () => (win && !win.isDestroyed() ? win.webContents.mainFrame : null);

// One-time sign-in of a (free) Google account for the bot: many Meet calls refuse guests.
function signIn() {
  const w = new BrowserWindow({ width: 500, height: 700, title: 'Sign in the note-taker', webPreferences: { session: botSession() } });
  w.loadURL(SIGN_IN);
}

module.exports = { start, stop, frame, signIn };
